//! Signed desktop updater and native check scheduler.
//!
//! Configuration is compiled into the binary from
//! `POSTWAVE_UPDATER_PUBKEY` and `POSTWAVE_UPDATER_ENDPOINT`. An entirely
//! absent pair disables updates; a partial or unsafe pair is an error. Every
//! request is independently constrained to HTTPS here before it reaches the
//! updater plugin. The pinned minisign public key is still what authorizes an
//! artifact for installation.

use std::{
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::ipc_guard::ensure_main_bundled_window;

const MAX_UPDATER_ENDPOINT_BYTES: usize = 2_048;
const MAX_RELEASE_NOTES_CHARS: usize = 16 * 1024;
const MAX_VERSION_CHARS: usize = 128;
const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(15);
const PERIODIC_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const UPDATE_STATE_EVENT: &str = "updater:state";
const MAX_UPDATE_ERROR_CHARS: usize = 512;

#[derive(Default)]
pub struct UpdaterOperationState {
    /// Manual checks, background checks, and installation share one lane so a
    /// startup tick cannot race an operator-triggered download/check.
    operation: Arc<Mutex<()>>,
    /// The scheduler can finish before the renderer has installed its event
    /// listener (for example while the keychain is unlocking). Retain the
    /// latest result so the renderer can perform a listener-first handshake
    /// and never depend on event timing for update availability.
    latest: Arc<RwLock<Option<UpdateStateSnapshot>>>,
}

impl UpdaterOperationState {
    fn remember(&self, snapshot: UpdateStateSnapshot) {
        match self.latest.write() {
            Ok(mut latest) => *latest = Some(snapshot),
            Err(poisoned) => *poisoned.into_inner() = Some(snapshot),
        }
    }

    fn snapshot(&self) -> Option<UpdateStateSnapshot> {
        match self.latest.read() {
            Ok(latest) => latest.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

/// Build-time updater configuration. A missing pair means this is an
/// intentionally updater-disabled development build. Partial configuration or
/// a non-HTTPS endpoint is surfaced as an error rather than silently disabled.
pub fn build_config() -> Result<Option<(&'static str, &'static str)>, String> {
    normalize_config(
        option_env!("POSTWAVE_UPDATER_PUBKEY"),
        option_env!("POSTWAVE_UPDATER_ENDPOINT"),
    )
}

fn normalize_config<'a>(
    pubkey: Option<&'a str>,
    endpoint: Option<&'a str>,
) -> Result<Option<(&'a str, &'a str)>, String> {
    let pubkey = pubkey.map(str::trim).filter(|value| !value.is_empty());
    let endpoint = endpoint.map(str::trim).filter(|value| !value.is_empty());

    match (pubkey, endpoint) {
        (None, None) => Ok(None),
        (Some(pubkey), Some(endpoint)) => {
            parse_secure_endpoint(endpoint)?;
            Ok(Some((pubkey, endpoint)))
        }
        _ => Err(
            "updater configuration requires both POSTWAVE_UPDATER_PUBKEY and \
             POSTWAVE_UPDATER_ENDPOINT"
                .to_string(),
        ),
    }
}

fn parse_secure_endpoint(endpoint: &str) -> Result<url::Url, String> {
    if endpoint.is_empty()
        || endpoint.len() > MAX_UPDATER_ENDPOINT_BYTES
        || endpoint.contains('\\')
        || endpoint.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
    {
        return Err("updater endpoint has an invalid length or control character".to_string());
    }
    let after_scheme = endpoint
        .strip_prefix("https://")
        .ok_or_else(|| "updater endpoint must use canonical HTTPS".to_string())?;
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() {
        return Err("updater endpoint must include a host".to_string());
    }
    let parsed =
        url::Url::parse(endpoint).map_err(|error| format!("invalid updater endpoint: {error}"))?;
    if parsed.scheme() != "https" {
        return Err("updater endpoint must use HTTPS".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("updater endpoint must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("updater endpoint must not contain credentials".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("updater endpoint must not contain a fragment".to_string());
    }
    Ok(parsed)
}

/// Result payload for `check_for_updates`. Field names cross the IPC/event
/// boundary as-is; keep them in lockstep with `UpdateCheckResult` in
/// `apps/desktop/src/lib/tauri.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateInfo {
    /// "not_configured" | "up_to_date" | "available".
    pub status: String,
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    /// Plain-text release severity supplied by the signed manifest. Unknown
    /// values fail to the conservative, non-alarming `recommended` level.
    pub severity: String,
    pub published_at: Option<String>,
    pub checked_at_ms: u64,
    /// `manual` for an operator action, `scheduled` for launch/six-hour checks.
    pub source: String,
}

impl UpdateInfo {
    fn not_configured(source: &str) -> Self {
        Self {
            status: "not_configured".to_string(),
            available: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            notes: None,
            severity: "recommended".to_string(),
            published_at: None,
            checked_at_ms: now_ms(),
            source: source.to_string(),
        }
    }

    fn up_to_date(source: &str) -> Self {
        Self {
            status: "up_to_date".to_string(),
            available: false,
            current_version: env!("CARGO_PKG_VERSION").to_string(),
            latest_version: None,
            notes: None,
            severity: "recommended".to_string(),
            published_at: None,
            checked_at_ms: now_ms(),
            source: source.to_string(),
        }
    }
}

/// Durable native handoff payload. Successful and failed scheduled checks are
/// both retained and emitted; the renderer therefore distinguishes a verified
/// up-to-date result from a check it could not complete.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UpdateStateSnapshot {
    pub result: Option<UpdateInfo>,
    pub error: Option<String>,
    pub checked_at_ms: u64,
    pub source: String,
}

impl UpdateStateSnapshot {
    fn success(result: UpdateInfo) -> Self {
        Self {
            checked_at_ms: result.checked_at_ms,
            source: result.source.clone(),
            result: Some(result),
            error: None,
        }
    }

    fn failure(source: &str, error: &str) -> Self {
        Self {
            result: None,
            error: Some(bounded_error(error)),
            checked_at_ms: now_ms(),
            source: source.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallResult {
    /// "not_configured" | "installed" | "up_to_date".
    pub status: String,
    pub version: Option<String>,
}

/// Build an updater with the already-pinned plugin key and a freshly validated
/// endpoint. This second validation prevents a future call site from bypassing
/// the build-config gate.
#[cfg(desktop)]
fn configured_updater(
    app: &AppHandle,
    endpoint: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;

    let endpoint = parse_secure_endpoint(endpoint)?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .configure_client(|client| {
            client.redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 5 {
                    attempt.error("too many updater redirects")
                } else if attempt.url().scheme() == "https"
                    && attempt.url().host_str().is_some()
                    && attempt.url().username().is_empty()
                    && attempt.url().password().is_none()
                    && attempt.url().fragment().is_none()
                {
                    attempt.follow()
                } else {
                    // Stopping leaves the 3xx as a non-success response; the
                    // plugin then fails the check/download instead of
                    // following an HTTPS-to-HTTP downgrade.
                    attempt.stop()
                }
            }))
        })
        .build()
        .map_err(|error| error.to_string())
}

async fn check_once(app: &AppHandle, source: &str) -> Result<UpdateInfo, String> {
    let Some((_pubkey, endpoint)) = build_config()? else {
        return Ok(UpdateInfo::not_configured(source));
    };

    let updater = configured_updater(app, endpoint)?;
    match updater.check().await {
        Ok(Some(update)) => {
            validate_download_url(&update.download_url)?;
            let latest_version = bounded_text(&update.version, MAX_VERSION_CHARS);
            info!(
                "update available: v{} (current v{})",
                latest_version,
                env!("CARGO_PKG_VERSION")
            );
            Ok(UpdateInfo {
                status: "available".to_string(),
                available: true,
                current_version: env!("CARGO_PKG_VERSION").to_string(),
                latest_version: Some(latest_version),
                notes: bounded_release_notes(update.body.as_deref()),
                severity: release_severity(&update.raw_json).to_string(),
                published_at: update.date.as_ref().map(ToString::to_string),
                checked_at_ms: now_ms(),
                source: source.to_string(),
            })
        }
        Ok(None) => Ok(UpdateInfo::up_to_date(source)),
        Err(error) => {
            warn!(%error, "update check failed");
            Err(error.to_string())
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn bounded_error(error: &str) -> String {
    bounded_text(error, MAX_UPDATE_ERROR_CHARS)
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn release_severity(raw: &serde_json::Value) -> &'static str {
    let declared = raw
        .get("severity")
        .or_else(|| raw.pointer("/metadata/severity"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim);
    match declared {
        Some(value) if value.eq_ignore_ascii_case("critical") => "critical",
        Some(value) if value.eq_ignore_ascii_case("important") => "important",
        Some(value) if value.eq_ignore_ascii_case("informational") => "informational",
        _ => "recommended",
    }
}

fn validate_download_url(download_url: &url::Url) -> Result<(), String> {
    parse_secure_endpoint(download_url.as_str())
        .map(|_| ())
        .map_err(|_| "update manifest contains an unsafe artifact URL".to_string())
}

fn bounded_release_notes(notes: Option<&str>) -> Option<String> {
    let notes = notes?.trim();
    if notes.is_empty() {
        return None;
    }
    Some(notes.chars().take(MAX_RELEASE_NOTES_CHARS).collect())
}

/// Check the configured HTTPS endpoint for a newer signed release.
#[tauri::command]
pub async fn check_for_updates(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdaterOperationState>,
) -> Result<UpdateInfo, String> {
    ensure_main_bundled_window(&window, "Updater")?;
    let operation = Arc::clone(&state.operation);
    let _guard = operation.lock().await;
    match check_once(&app, "manual").await {
        Ok(info) => {
            state.remember(UpdateStateSnapshot::success(info.clone()));
            Ok(info)
        }
        Err(error) => {
            state.remember(UpdateStateSnapshot::failure("manual", &error));
            Err(error)
        }
    }
}

/// Return the retained scheduler/manual result after the renderer has
/// installed its listener. This closes the native-before-renderer event race.
#[tauri::command]
pub fn get_update_state(
    window: WebviewWindow,
    state: State<'_, UpdaterOperationState>,
) -> Result<Option<UpdateStateSnapshot>, String> {
    ensure_main_bundled_window(&window, "Updater")?;
    Ok(state.snapshot())
}

/// Download and apply the latest signed release. Installation always remains
/// operator-triggered; scheduled checks never download or restart. The Tauri
/// updater verifies the artifact signature against the build-pinned public key
/// before applying it.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, UpdaterOperationState>,
) -> Result<InstallResult, String> {
    ensure_main_bundled_window(&window, "Updater")?;
    let operation = Arc::clone(&state.operation);
    let _guard = operation.lock().await;

    let Some((_pubkey, endpoint)) = build_config()? else {
        return Ok(InstallResult {
            status: "not_configured".to_string(),
            version: None,
        });
    };
    let updater = configured_updater(&app, endpoint)?;
    let update = match updater.check().await.map_err(|error| error.to_string())? {
        Some(update) => update,
        None => {
            return Ok(InstallResult {
                status: "up_to_date".to_string(),
                version: None,
            })
        }
    };
    validate_download_url(&update.download_url)?;

    let installing_version = bounded_text(&update.version, MAX_VERSION_CHARS);
    info!("downloading signed update v{}", installing_version);
    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = progress_app.emit(
                    "updater:download-progress",
                    serde_json::json!({ "downloaded": downloaded, "total": total }),
                );
            },
            || info!("update download finished; verifying and installing"),
        )
        .await
        .map_err(|error| error.to_string())?;

    info!("signed update installed; relaunch required");
    Ok(InstallResult {
        status: "installed".to_string(),
        version: Some(installing_version),
    })
}

/// Start one delayed launch check followed by a six-hour cadence. Only
/// updater-enabled builds spawn the task. Every result is retained before it
/// is emitted, so a renderer that starts late can recover the exact state.
pub fn spawn_update_scheduler(app: AppHandle) {
    match build_config() {
        Ok(Some(_)) => {}
        Ok(None) => return,
        Err(error) => {
            warn!(%error, "automatic update checks disabled by invalid build configuration");
            return;
        }
    }

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_CHECK_DELAY).await;
        loop {
            if app
                .state::<crate::diagnostics::DiagnosticsState>()
                .is_safe_mode()
            {
                info!("automatic update check paused while Safe Mode is active");
                tokio::time::sleep(PERIODIC_CHECK_INTERVAL).await;
                continue;
            }
            let operation = Arc::clone(&app.state::<UpdaterOperationState>().operation);
            let result = {
                let _guard = operation.lock().await;
                check_once(&app, "scheduled").await
            };
            let snapshot = match result {
                Ok(info) => {
                    info!(status = %info.status, "automatic update check completed");
                    UpdateStateSnapshot::success(info)
                }
                Err(error) => {
                    warn!(%error, "automatic update check failed");
                    UpdateStateSnapshot::failure("scheduled", &error)
                }
            };
            app.state::<UpdaterOperationState>()
                .remember(snapshot.clone());
            if let Err(error) = app.emit(UPDATE_STATE_EVENT, snapshot) {
                warn!(%error, "failed to emit automatic update state");
            }
            tokio::time::sleep(PERIODIC_CHECK_INTERVAL).await;
        }
    });
}

#[tauri::command]
pub fn restart_app(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Updater")?;
    crate::window_lifecycle::approve_exit(&app);
    let _ = crate::diagnostics::record_native_lifecycle(&app, "exit_approved");
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::{
        bounded_error, bounded_release_notes, bounded_text, normalize_config,
        parse_secure_endpoint, release_severity, validate_download_url, UpdateInfo,
        UpdateStateSnapshot, UpdaterOperationState, PERIODIC_CHECK_INTERVAL, STARTUP_CHECK_DELAY,
    };
    use std::time::Duration;

    // Canonical spelling, NOT a security boundary — worth being explicit about
    // which this is. Removing the strict `strip_prefix("https://")` leaves
    // http:// and ftp:// still rejected by the scheme check below it, so no
    // insecure endpoint becomes reachable. What it does control is whether
    // "HTTPS://host" and "https:/host" (single slash) are accepted, and today
    // they are not. Nothing pinned that, so the strictness could drift either
    // way unnoticed.
    #[test]
    fn updater_endpoint_must_be_spelled_canonically() {
        assert!(parse_secure_endpoint("https://updates.moosewave.com/latest.json").is_ok());
        assert!(parse_secure_endpoint("HTTPS://updates.moosewave.com/latest.json").is_err());
        assert!(parse_secure_endpoint("https:/updates.moosewave.com/latest.json").is_err());
        // The security property itself, which is separately guarded by the
        // scheme check and must hold regardless of the above.
        assert!(parse_secure_endpoint("http://updates.moosewave.com/latest.json").is_err());
        assert!(parse_secure_endpoint("ftp://updates.moosewave.com/latest.json").is_err());
    }

    #[test]
    fn absent_pair_disables_but_partial_configuration_is_an_error() {
        assert_eq!(normalize_config(None, None), Ok(None));
        assert!(normalize_config(Some("key"), None).is_err());
        assert!(normalize_config(None, Some("https://r.example/u")).is_err());
        assert!(normalize_config(Some(""), Some("https://r.example/u")).is_err());
        assert!(normalize_config(Some("key"), Some("")).is_err());
    }

    #[test]
    fn complete_configuration_is_trimmed_and_https_validated() {
        assert_eq!(
            normalize_config(
                Some(" pubkey \n"),
                Some(" https://r.example/{{target}}/{{arch}} ")
            ),
            Ok(Some(("pubkey", "https://r.example/{{target}}/{{arch}}")))
        );
    }

    #[test]
    fn endpoint_validator_rejects_insecure_or_ambiguous_urls() {
        for endpoint in [
            "http://releases.example/update",
            "ftp://releases.example/update",
            "https:///update",
            "https://user:pass@releases.example/update",
            "https://releases.example/update#other-manifest",
            "https://releases.example/update\nX-Injected: yes",
        ] {
            assert!(
                parse_secure_endpoint(endpoint).is_err(),
                "accepted {endpoint:?}"
            );
        }
        assert!(parse_secure_endpoint("https://releases.example/{{target}}/{{arch}}").is_ok());
    }

    #[test]
    fn manifest_artifact_url_must_also_be_https() {
        assert!(validate_download_url(
            &url::Url::parse("https://cdn.example/Moosewave.app.tar.gz").unwrap()
        )
        .is_ok());
        assert!(validate_download_url(
            &url::Url::parse("http://cdn.example/Moosewave.app.tar.gz").unwrap()
        )
        .is_err());
        assert!(validate_download_url(
            &url::Url::parse("https://user:pass@cdn.example/update.exe").unwrap()
        )
        .is_err());
    }

    #[test]
    fn automatic_check_cadence_is_startup_then_six_hourly() {
        assert_eq!(STARTUP_CHECK_DELAY, Duration::from_secs(15));
        assert_eq!(PERIODIC_CHECK_INTERVAL, Duration::from_secs(21_600));
    }

    #[test]
    fn release_notes_are_bounded_before_crossing_ipc() {
        assert_eq!(bounded_release_notes(None), None);
        assert_eq!(bounded_release_notes(Some("  \n")), None);
        assert_eq!(bounded_release_notes(Some(" notes ")), Some("notes".into()));
        assert_eq!(
            bounded_release_notes(Some(&"x".repeat(20_000)))
                .unwrap()
                .chars()
                .count(),
            16 * 1024
        );
        assert_eq!(bounded_text(&"1".repeat(500), 128).chars().count(), 128);
    }

    #[test]
    fn signed_manifest_severity_is_allowlisted() {
        assert_eq!(
            release_severity(&serde_json::json!({ "severity": "CRITICAL" })),
            "critical"
        );
        assert_eq!(
            release_severity(&serde_json::json!({
                "metadata": { "severity": "important" }
            })),
            "important"
        );
        assert_eq!(
            release_severity(&serde_json::json!({ "severity": "emergency" })),
            "recommended"
        );
        assert_eq!(release_severity(&serde_json::json!({})), "recommended");
    }

    #[test]
    fn scheduler_snapshot_survives_a_late_renderer_handshake() {
        let state = UpdaterOperationState::default();
        assert_eq!(state.snapshot(), None);
        let result = UpdateInfo {
            status: "available".to_string(),
            available: true,
            current_version: "1.0.0".to_string(),
            latest_version: Some("1.1.0".to_string()),
            notes: Some("Security and reliability fixes".to_string()),
            severity: "important".to_string(),
            published_at: Some("2026-07-16T10:00:00Z".to_string()),
            checked_at_ms: 42,
            source: "scheduled".to_string(),
        };
        state.remember(UpdateStateSnapshot::success(result.clone()));
        assert_eq!(
            state.snapshot(),
            Some(UpdateStateSnapshot {
                result: Some(result),
                error: None,
                checked_at_ms: 42,
                source: "scheduled".to_string(),
            })
        );
    }

    #[test]
    fn scheduled_errors_are_retained_but_bounded() {
        let snapshot = UpdateStateSnapshot::failure("scheduled", &"x".repeat(4_096));
        assert_eq!(snapshot.source, "scheduled");
        assert_eq!(snapshot.error.unwrap().chars().count(), 512);
        assert_eq!(
            bounded_error("  network unavailable  "),
            "network unavailable"
        );
    }
}
