//! Privacy-safe native crash markers and bounded rotating diagnostic logs.
//!
//! No panic payload, renderer message, stack, route, identity, request body,
//! or credential is accepted by this module. Both the panic hook and renderer
//! IPC reduce failures to structural incident IDs, kinds, symbols, and source
//! component names before writing local data.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::ipc_guard::ensure_main_bundled_window;

const DIAGNOSTICS_DIR: &str = "diagnostics";
const CURRENT_LOG: &str = "events.log";
const MAX_LOG_BYTES: u64 = 256 * 1024;
const MAX_ROTATED_LOGS: usize = 2;
const MAX_BUNDLE_BYTES: usize = 48 * 1024;
const MAX_COMPONENTS: usize = 8;
const MAX_SYMBOL_BYTES: usize = 64;
static INCIDENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static PANIC_MARKER_PATH: OnceLock<Mutex<PathBuf>> = OnceLock::new();

#[derive(Default)]
pub struct DiagnosticsState {
    startup_crash: Mutex<Option<NativeCrashRecord>>,
    safe_mode: AtomicBool,
}

impl DiagnosticsState {
    pub fn is_safe_mode(&self) -> bool {
        self.safe_mode.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrashRecord {
    pub incident_id: String,
    pub occurred_at_ms: u64,
    pub kind: String,
    pub location: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererDiagnosticRecord {
    incident_id: String,
    occurred_at_ms: u64,
    kind: String,
    error_type: String,
    error_code: Option<String>,
    component_trace: Vec<String>,
    safe_mode: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticLogEvent<'a> {
    occurred_at_ms: u64,
    incident_id: &'a str,
    source: &'a str,
    kind: &'a str,
    error_type: &'a str,
    error_code: Option<&'a str>,
    component_trace: &'a [String],
    safe_mode: bool,
}

/// Install before Tauri/plugin initialization so setup panics still leave a
/// one-shot marker. The path is moved into app-local data during setup.
pub fn install_panic_hook() {
    let marker = PANIC_MARKER_PATH.get_or_init(|| Mutex::new(temporary_marker_path()));
    let _ = marker;
    std::panic::set_hook(Box::new(|info| {
        let occurred_at_ms = now_ms();
        let record = NativeCrashRecord {
            incident_id: new_native_incident_id(occurred_at_ms),
            occurred_at_ms,
            kind: "native_panic".to_string(),
            location: info.location().map(|location| {
                let file = Path::new(location.file())
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("unknown");
                format!("{}:{}", sanitize_symbol(file), location.line())
            }),
        };
        if let Some(path) = PANIC_MARKER_PATH
            .get()
            .and_then(|value| value.lock().ok().map(|path| path.clone()))
        {
            let _ = write_private_json(&path, &record);
        }
        // Never print the panic payload: it may contain a URL, request body,
        // user-entered content, or credential. The incident ID is sufficient
        // to correlate the marker with the next-launch recovery surface.
        eprintln!("Moosewave Desktop native panic: {}", record.incident_id);
    }));
}

/// Move the panic marker into app-local storage, consume a prior marker, and
/// append a structural startup event. Diagnostics failure never exposes a path
/// or raw OS error to the renderer.
pub fn initialize<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let directory = diagnostic_directory(app)?;
    create_private_dir(&directory)?;
    let target_marker = directory.join("native-crash.marker");
    let old_marker = PANIC_MARKER_PATH
        .get_or_init(|| Mutex::new(temporary_marker_path()))
        .lock()
        .map_err(|_| "diagnostic marker lock unavailable".to_string())?
        .clone();

    let mut recovered_records = Vec::new();
    let candidates = if target_marker == old_marker {
        vec![target_marker.clone()]
    } else {
        vec![target_marker.clone(), old_marker]
    };
    for candidate in &candidates {
        if let Some(record) = read_crash_marker(candidate) {
            recovered_records.push(record);
        }
        let _ = fs::remove_file(candidate);
    }
    *PANIC_MARKER_PATH
        .get_or_init(|| Mutex::new(temporary_marker_path()))
        .lock()
        .map_err(|_| "diagnostic marker lock unavailable".to_string())? = target_marker;

    recovered_records.sort_by_key(|record| record.occurred_at_ms);
    for record in &recovered_records {
        append_native_crash(&directory, record)?;
    }
    let recovered = recovered_records.pop();
    if let Ok(mut startup_crash) = app.state::<DiagnosticsState>().startup_crash.lock() {
        *startup_crash = recovered;
    }
    append_structural_line(
        &directory,
        &serde_json::json!({
            "occurredAtMs": now_ms(),
            "source": "native",
            "kind": "startup"
        })
        .to_string(),
    )
}

/// Append one of the fixed, payload-free native lifecycle events to the
/// rotating structural journal. Callers cannot attach user content, routes,
/// workspace names or OS error strings.
pub fn record_native_lifecycle<R: Runtime>(
    app: &AppHandle<R>,
    kind: &'static str,
) -> Result<(), String> {
    if !matches!(
        kind,
        "os_shutdown_requested" | "window_close_requested" | "exit_approved"
    ) {
        return Err("invalid native lifecycle diagnostic".to_string());
    }
    let directory = diagnostic_directory(app)?;
    create_private_dir(&directory)?;
    append_structural_line(
        &directory,
        &serde_json::json!({
            "occurredAtMs": now_ms(),
            "source": "native",
            "kind": kind
        })
        .to_string(),
    )
}

#[tauri::command]
pub fn diagnostics_record_renderer_event<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    record: RendererDiagnosticRecord,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Desktop diagnostics")?;
    validate_renderer_record(&record)?;
    let directory = diagnostic_directory(&app)?;
    create_private_dir(&directory)?;
    let event = DiagnosticLogEvent {
        occurred_at_ms: record.occurred_at_ms,
        incident_id: &record.incident_id,
        source: "renderer",
        kind: &record.kind,
        error_type: &record.error_type,
        error_code: record.error_code.as_deref(),
        component_trace: &record.component_trace,
        safe_mode: record.safe_mode,
    };
    let line = serde_json::to_string(&event).map_err(|_| "diagnostic encoding failed")?;
    append_structural_line(&directory, &line)
}

#[tauri::command]
pub fn diagnostics_take_startup_crash(
    window: WebviewWindow,
    state: tauri::State<'_, DiagnosticsState>,
) -> Result<Option<NativeCrashRecord>, String> {
    ensure_main_bundled_window(&window, "Desktop diagnostics")?;
    state
        .startup_crash
        .lock()
        .map(|mut record| record.take())
        .map_err(|_| "diagnostic state unavailable".to_string())
}

#[tauri::command]
pub fn diagnostics_set_safe_mode(
    window: WebviewWindow,
    state: tauri::State<'_, DiagnosticsState>,
    active: bool,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Desktop diagnostics")?;
    state.safe_mode.store(active, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn diagnostics_read_recent<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<String, String> {
    ensure_main_bundled_window(&window, "Desktop diagnostics")?;
    read_recent_bundle(&diagnostic_directory(&app)?)
}

fn validate_renderer_record(record: &RendererDiagnosticRecord) -> Result<(), String> {
    if !valid_incident_id(&record.incident_id) {
        return Err("invalid diagnostic incident id".to_string());
    }
    if !matches!(
        record.kind.as_str(),
        "renderer_boundary" | "window_error" | "unhandled_rejection" | "bootstrap_failure"
    ) {
        return Err("invalid diagnostic kind".to_string());
    }
    if !valid_symbol(&record.error_type) {
        return Err("invalid diagnostic error type".to_string());
    }
    if record
        .error_code
        .as_deref()
        .is_some_and(|value| !valid_error_code(value))
    {
        return Err("invalid diagnostic error code".to_string());
    }
    if record.component_trace.len() > MAX_COMPONENTS
        || record
            .component_trace
            .iter()
            .any(|component| !valid_symbol(component))
    {
        return Err("invalid diagnostic component trace".to_string());
    }
    Ok(())
}

fn append_native_crash(directory: &Path, record: &NativeCrashRecord) -> Result<(), String> {
    let location = record.location.as_deref().unwrap_or("unknown");
    let event = serde_json::json!({
        "occurredAtMs": record.occurred_at_ms,
        "incidentId": record.incident_id,
        "source": "native",
        "kind": "native_panic",
        "location": location
    });
    append_structural_line(directory, &event.to_string())
}

fn append_structural_line(directory: &Path, line: &str) -> Result<(), String> {
    if line.len() > 4 * 1024 || line.bytes().any(|byte| byte == b'\n' || byte == b'\r') {
        return Err("diagnostic entry rejected".to_string());
    }
    rotate_if_needed(directory, line.len() as u64 + 1)?;
    let path = directory.join(CURRENT_LOG);
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "diagnostic log unavailable".to_string())?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.flush())
        .map_err(|_| "diagnostic log write failed".to_string())
}

fn rotate_if_needed(directory: &Path, incoming: u64) -> Result<(), String> {
    let current = directory.join(CURRENT_LOG);
    let current_size = fs::metadata(&current).map(|meta| meta.len()).unwrap_or(0);
    if current_size.saturating_add(incoming) <= MAX_LOG_BYTES {
        return Ok(());
    }
    let oldest = rotated_log_path(directory, MAX_ROTATED_LOGS);
    let _ = fs::remove_file(oldest);
    for index in (1..=MAX_ROTATED_LOGS).rev() {
        let source = if index == 1 {
            current.clone()
        } else {
            rotated_log_path(directory, index - 1)
        };
        let target = rotated_log_path(directory, index);
        if source.exists() {
            fs::rename(source, target).map_err(|_| "diagnostic log rotation failed".to_string())?;
        }
    }
    Ok(())
}

fn read_recent_bundle(directory: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    for index in (1..=MAX_ROTATED_LOGS).rev() {
        append_file_bounded(&rotated_log_path(directory, index), &mut bytes)?;
    }
    append_file_bounded(&directory.join(CURRENT_LOG), &mut bytes)?;
    let raw =
        String::from_utf8(bytes).map_err(|_| "diagnostic log encoding invalid".to_string())?;
    let mut safe_lines = raw
        .lines()
        .filter_map(sanitize_stored_log_line)
        .collect::<Vec<_>>();
    let mut size = safe_lines.iter().map(|line| line.len() + 1).sum::<usize>();
    while size > MAX_BUNDLE_BYTES && safe_lines.len() > 1 {
        size = size.saturating_sub(safe_lines.remove(0).len() + 1);
    }
    Ok(safe_lines.join("\n"))
}

fn sanitize_stored_log_line(line: &str) -> Option<String> {
    if line.is_empty() || line.len() > 4 * 1024 {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
    let source = value.get("source")?.as_str()?;
    let kind = value.get("kind")?.as_str()?;
    let occurred_at_ms = value.get("occurredAtMs")?.as_u64()?;
    match (source, kind) {
        ("native", "startup") => Some(
            serde_json::json!({
                "occurredAtMs": occurred_at_ms,
                "source": "native",
                "kind": "startup"
            })
            .to_string(),
        ),
        ("native", "native_panic") => {
            let incident_id = value.get("incidentId")?.as_str()?;
            let location = value.get("location")?.as_str()?;
            if !valid_incident_id(incident_id) || !valid_location(location) {
                return None;
            }
            Some(
                serde_json::json!({
                    "occurredAtMs": occurred_at_ms,
                    "incidentId": incident_id,
                    "source": "native",
                    "kind": "native_panic",
                    "location": location
                })
                .to_string(),
            )
        }
        ("renderer", renderer_kind)
            if matches!(
                renderer_kind,
                "renderer_boundary" | "window_error" | "unhandled_rejection" | "bootstrap_failure"
            ) =>
        {
            let incident_id = value.get("incidentId")?.as_str()?;
            let error_type = value.get("errorType")?.as_str()?;
            let error_code = value.get("errorCode").and_then(serde_json::Value::as_str);
            let safe_mode = value.get("safeMode")?.as_bool()?;
            let component_trace = value
                .get("componentTrace")?
                .as_array()?
                .iter()
                .map(serde_json::Value::as_str)
                .collect::<Option<Vec<_>>>()?;
            if !valid_incident_id(incident_id)
                || !valid_symbol(error_type)
                || error_code.is_some_and(|code| !valid_error_code(code))
                || component_trace.len() > MAX_COMPONENTS
                || component_trace
                    .iter()
                    .any(|component| !valid_symbol(component))
            {
                return None;
            }
            Some(
                serde_json::json!({
                    "occurredAtMs": occurred_at_ms,
                    "incidentId": incident_id,
                    "source": "renderer",
                    "kind": renderer_kind,
                    "errorType": error_type,
                    "errorCode": error_code,
                    "componentTrace": component_trace,
                    "safeMode": safe_mode
                })
                .to_string(),
            )
        }
        _ => None,
    }
}

fn append_file_bounded(path: &Path, output: &mut Vec<u8>) -> Result<(), String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("diagnostic log read failed".to_string()),
    };
    let mut chunk = Vec::new();
    file.read_to_end(&mut chunk)
        .map_err(|_| "diagnostic log read failed".to_string())?;
    output.extend_from_slice(&chunk);
    if output.len() > MAX_BUNDLE_BYTES * 2 {
        let remove = output.len() - MAX_BUNDLE_BYTES;
        output.drain(..remove);
    }
    Ok(())
}

fn read_crash_marker(path: &Path) -> Option<NativeCrashRecord> {
    let bytes = fs::read(path).ok()?;
    if bytes.len() > 2 * 1024 {
        return None;
    }
    let record = serde_json::from_slice::<NativeCrashRecord>(&bytes).ok()?;
    if valid_incident_id(&record.incident_id)
        && record.kind == "native_panic"
        && record.location.as_deref().is_none_or(valid_location)
    {
        Some(record)
    } else {
        None
    }
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let bytes = serde_json::to_vec(value).map_err(|_| "diagnostic encoding failed")?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "diagnostic marker unavailable".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.flush())
        .map_err(|_| "diagnostic marker write failed".to_string())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "diagnostic directory unavailable".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn diagnostic_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| path.join(DIAGNOSTICS_DIR))
        .map_err(|_| "diagnostic directory unavailable".to_string())
}

fn temporary_marker_path() -> PathBuf {
    std::env::temp_dir()
        .join("postwave-desktop")
        .join("native-crash.marker")
}

fn rotated_log_path(directory: &Path, index: usize) -> PathBuf {
    directory.join(format!("events.{index}.log"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn new_native_incident_id(at_ms: u64) -> String {
    let sequence = INCIDENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "PW-N-{at_ms:016X}-{:08X}-{sequence:08X}",
        std::process::id()
    )
}

fn sanitize_symbol(value: &str) -> String {
    value
        .chars()
        .take(MAX_SYMBOL_BYTES)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-' | ':') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn valid_incident_id(value: &str) -> bool {
    (12..=64).contains(&value.len())
        && value.starts_with("PW-")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_symbol(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SYMBOL_BYTES
        && !contains_sensitive_marker(value)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'$' | b'-'))
}

fn valid_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && !contains_sensitive_marker(value)
        && value.as_bytes()[0].is_ascii_uppercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn contains_sensitive_marker(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase().replace('-', "_");
    [
        "api_key",
        "authorization",
        "bearer",
        "cookie",
        "oauth",
        "password",
        "pw_live",
        "secret",
        "session",
        "token",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn valid_location(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b':'))
}

#[cfg(test)]
mod tests {
    use super::{
        append_structural_line, new_native_incident_id, read_crash_marker, read_recent_bundle,
        valid_incident_id, validate_renderer_record, NativeCrashRecord, RendererDiagnosticRecord,
        MAX_LOG_BYTES,
    };
    use std::fs;
    use std::path::PathBuf;

    fn temp_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "postwave-diagnostics-test-{name}-{}-{}",
            std::process::id(),
            super::INCIDENT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn renderer_contract_rejects_free_form_or_secret_bearing_fields() {
        let valid = RendererDiagnosticRecord {
            incident_id: "PW-20260716-A1B2C3D4E5".to_string(),
            occurred_at_ms: 1_752_652_800_000,
            kind: "renderer_boundary".to_string(),
            error_type: "TypeError".to_string(),
            error_code: Some("E_RENDER".to_string()),
            component_trace: vec!["CampaignEditor".to_string()],
            safe_mode: false,
        };
        assert!(validate_renderer_record(&valid).is_ok());

        let mut unsafe_record = valid;
        unsafe_record.error_type = "Bearer pw_live_secret".to_string();
        assert!(validate_renderer_record(&unsafe_record).is_err());

        unsafe_record.error_type = "TypeError".to_string();
        unsafe_record.error_code = Some("PW_LIVE_SECRET".to_string());
        assert!(validate_renderer_record(&unsafe_record).is_err());
    }

    #[test]
    fn native_marker_contains_no_panic_payload_and_is_strictly_parsed() {
        let directory = temp_directory("marker");
        let path = directory.join("marker.json");
        let record = NativeCrashRecord {
            incident_id: new_native_incident_id(42),
            occurred_at_ms: 42,
            kind: "native_panic".to_string(),
            location: Some("main.rs:12".to_string()),
        };
        fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(read_crash_marker(&path), Some(record));

        let developer_path = ["/", "Users", "/alice/secret.rs:2"].concat();
        let invalid_marker = format!(
            r#"{{"incidentId":"PW-INVALID","occurredAtMs":42,"kind":"native_panic","location":"{developer_path}"}}"#
        );
        fs::write(&path, invalid_marker.as_bytes()).unwrap();
        assert!(read_crash_marker(&path).is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn log_rotates_and_bundle_is_bounded() {
        let directory = temp_directory("rotation");
        let padding = "A".repeat(3_900);
        for index in 0..160 {
            append_structural_line(
                &directory,
                &format!(r#"{{"kind":"startup","index":{index},"padding":"{padding}"}}"#),
            )
            .unwrap();
        }
        append_structural_line(
            &directory,
            r#"{"occurredAtMs":42,"source":"native","kind":"startup","message":"pw_live_never-copy"}"#,
        )
        .unwrap();
        assert!(directory.join("events.1.log").exists());
        assert!(fs::metadata(directory.join("events.log")).unwrap().len() <= MAX_LOG_BYTES);
        let bundle = read_recent_bundle(&directory).unwrap();
        assert!(bundle.len() <= 48 * 1024);
        assert!(bundle.contains(r#""kind":"startup""#));
        assert!(!bundle.contains("pw_live_"));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn generated_incident_ids_are_allowlisted() {
        assert!(valid_incident_id(&new_native_incident_id(1)));
    }
}
