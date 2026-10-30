//! Native authenticated API transport.
//!
//! The renderer may submit a credential once (while the operator is entering
//! it), but it can never read a stored credential back. Every persisted
//! bearer is bound to its API base URL and every broker request is rebuilt
//! from that record, with redirects disabled and credential-like caller
//! headers rejected.

use std::collections::{BTreeMap, HashMap};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use url::Url;

use crate::ipc_guard::ensure_main_bundled_window;

const SECRET_SERVICE: &str = "com.moosewave.desktop";
const ACTIVE_ACCOUNT: &str = "api_broker_credential_v2";
const LEGACY_ACTIVE_ACCOUNT: &str = "api_key";
const WORKSPACE_ACCOUNT_PREFIX: &str = "api_broker_workspace_v2:";
const LEGACY_WORKSPACE_PREFIX: &str = "api_key:";
const DISABLED_MARKER: &str = "api-credential-disabled-v2";
const MAX_SECRET_BYTES: usize = 8 * 1024;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct CredentialRecord {
    version: u8,
    base_url: String,
    bearer: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerRequest {
    pub request_id: String,
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Vec<u8>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerProbeRequest {
    pub base_url: String,
    pub url: String,
    pub api_key: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponseHead {
    pub status: u16,
    pub status_text: String,
    pub headers: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case", tag = "event")]
pub enum BrokerStreamSignal {
    Complete,
    Error { message: String },
}

/// Deliberately contains no credential material.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerStatus {
    pub configured: bool,
    pub base_url: Option<String>,
    /// One-way identity used to partition offline state. This value cannot
    /// authenticate a request and never contains the bearer itself.
    pub credential_fingerprint: Option<String>,
    pub legacy_reentry_required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    pub id: String,
    pub base_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCredentialStatus {
    pub id: String,
    pub configured: bool,
    pub legacy_reentry_required: bool,
}

pub struct ApiBrokerState {
    client: reqwest::Client,
    active: RwLock<Option<CredentialRecord>>,
    /// The source-only demo launcher injects a process-scoped credential so
    /// product walkthroughs never need to unlock or modify the user's OS
    /// credential store. This path is compiled out of release builds.
    ephemeral_demo: bool,
    credential_transaction: Mutex<()>,
    credential_consistent: AtomicBool,
    cancellations: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
}

impl ApiBrokerState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("build native API client");
        #[cfg(debug_assertions)]
        let demo_credential = demo_credential_from_env();
        #[cfg(not(debug_assertions))]
        let demo_credential: Option<CredentialRecord> = None;
        let ephemeral_demo = demo_credential.is_some();
        Self {
            client,
            active: RwLock::new(demo_credential),
            ephemeral_demo,
            credential_transaction: Mutex::new(()),
            credential_consistent: AtomicBool::new(true),
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn cached(&self) -> Result<Option<CredentialRecord>, String> {
        self.active
            .read()
            .map(|value| value.clone())
            .map_err(|_| "API credential state is unavailable".to_string())
    }

    fn replace_cached(&self, value: Option<CredentialRecord>) -> Result<(), String> {
        *self
            .active
            .write()
            .map_err(|_| "API credential state is unavailable".to_string())? = value;
        Ok(())
    }

    /// Prefer the process-held copy so routine API calls neither block on nor
    /// re-prompt the OS credential store. The keyring is only consulted when
    /// this process has not hydrated a credential yet.
    fn ensure_credential_consistent(&self) -> Result<(), String> {
        if self.credential_consistent.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(
                "Native credential state is inconsistent. Restart Moosewave before making requests"
                    .to_string(),
            )
        }
    }

    fn lock_credential_transaction(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        let guard = self
            .credential_transaction
            .lock()
            .map_err(|_| "API credential transaction state is unavailable".to_string())?;
        self.ensure_credential_consistent()?;
        Ok(guard)
    }

    fn cached_or_keyring_unlocked(&self) -> Result<Option<CredentialRecord>, String> {
        match self.cached()? {
            Some(record) => Ok(Some(record)),
            None => read_record(ACTIVE_ACCOUNT),
        }
    }

    fn cached_or_keyring(&self) -> Result<Option<CredentialRecord>, String> {
        let _transaction = self.lock_credential_transaction()?;
        self.cached_or_keyring_unlocked()
    }

    fn mark_credential_inconsistent(&self) {
        self.credential_consistent.store(false, Ordering::Release);
    }
}

const WORKSPACE_SWITCH_FATAL_PREFIX: &str = "FATAL_WORKSPACE_SWITCH_INCONSISTENT";

trait WorkspaceSwitchBackend {
    fn read_cached(&mut self) -> Result<Option<CredentialRecord>, String>;
    fn replace_cached(&mut self, value: Option<CredentialRecord>) -> Result<(), String>;
    fn read_active(&mut self) -> Result<Option<CredentialRecord>, String>;
    fn write_active(&mut self, record: &CredentialRecord) -> Result<(), String>;
    fn delete_active(&mut self) -> Result<(), String>;
    fn read_disabled_marker(&mut self) -> Result<bool, String>;
    fn write_disabled_marker(&mut self) -> Result<(), String>;
    fn clear_disabled_marker(&mut self) -> Result<(), String>;
    fn read_workspace(&mut self, id: &str) -> Result<Option<CredentialRecord>, String>;
    fn write_workspace(&mut self, id: &str, record: &CredentialRecord) -> Result<(), String>;
    fn delete_workspace(&mut self, id: &str) -> Result<(), String>;
    fn mark_inconsistent(&mut self);
}

struct NativeWorkspaceSwitchBackend<'a> {
    app: &'a AppHandle,
    state: &'a ApiBrokerState,
}

impl WorkspaceSwitchBackend for NativeWorkspaceSwitchBackend<'_> {
    fn read_cached(&mut self) -> Result<Option<CredentialRecord>, String> {
        self.state.cached()
    }

    fn replace_cached(&mut self, value: Option<CredentialRecord>) -> Result<(), String> {
        self.state.replace_cached(value)
    }

    fn read_active(&mut self) -> Result<Option<CredentialRecord>, String> {
        read_record(ACTIVE_ACCOUNT)
    }

    fn write_active(&mut self, record: &CredentialRecord) -> Result<(), String> {
        write_record(ACTIVE_ACCOUNT, record)
    }

    fn delete_active(&mut self) -> Result<(), String> {
        delete_account(ACTIVE_ACCOUNT)
    }

    fn read_disabled_marker(&mut self) -> Result<bool, String> {
        credential_is_disabled(self.app)
    }

    fn write_disabled_marker(&mut self) -> Result<(), String> {
        write_disabled_marker(self.app)
    }

    fn clear_disabled_marker(&mut self) -> Result<(), String> {
        clear_disabled_marker(self.app)
    }

    fn read_workspace(&mut self, id: &str) -> Result<Option<CredentialRecord>, String> {
        read_record(&workspace_account(id))
    }

    fn write_workspace(&mut self, id: &str, record: &CredentialRecord) -> Result<(), String> {
        write_record(&workspace_account(id), record)
    }

    fn delete_workspace(&mut self, id: &str) -> Result<(), String> {
        delete_account(&workspace_account(id))
    }

    fn mark_inconsistent(&mut self) {
        self.state.mark_credential_inconsistent();
    }
}

#[derive(Clone)]
struct WorkspaceSwitchSnapshot {
    cached: Option<CredentialRecord>,
    active: Option<CredentialRecord>,
    disabled: bool,
    current_workspace: Option<CredentialRecord>,
}

fn restore_workspace_switch<B: WorkspaceSwitchBackend>(
    backend: &mut B,
    current_id: &str,
    snapshot: &WorkspaceSwitchSnapshot,
) -> Vec<String> {
    let mut failures = Vec::new();
    let active_result = match &snapshot.active {
        Some(record) => backend.write_active(record),
        None => backend.delete_active(),
    };
    if let Err(error) = active_result {
        failures.push(format!("active credential: {error}"));
    }

    let marker_result = if snapshot.disabled {
        backend.write_disabled_marker()
    } else {
        backend.clear_disabled_marker()
    };
    if let Err(error) = marker_result {
        failures.push(format!("disabled marker: {error}"));
    }

    if let Err(error) = backend.replace_cached(snapshot.cached.clone()) {
        failures.push(format!("process credential cache: {error}"));
    }

    // Retain the freshly-saved current credential as a recovery copy when a
    // more important active-state restore failed. Otherwise return the current
    // workspace slot to its exact pre-transaction value.
    if failures.is_empty() {
        let workspace_result = match &snapshot.current_workspace {
            Some(record) => backend.write_workspace(current_id, record),
            None => backend.delete_workspace(current_id),
        };
        if let Err(error) = workspace_result {
            failures.push(format!("current workspace credential: {error}"));
        }
    }
    failures
}

fn force_workspace_switch_fail_closed<B: WorkspaceSwitchBackend>(backend: &mut B) -> Vec<String> {
    backend.mark_inconsistent();
    let mut failures = Vec::new();
    if let Err(error) = backend.write_disabled_marker() {
        failures.push(format!("write fail-closed marker: {error}"));
    }
    if let Err(error) = backend.delete_active() {
        failures.push(format!("delete uncertain active credential: {error}"));
    }
    if let Err(error) = backend.replace_cached(None) {
        failures.push(format!("clear process credential cache: {error}"));
    }
    failures
}

fn perform_workspace_switch_transaction<B: WorkspaceSwitchBackend>(
    backend: &mut B,
    current_id: &str,
    target_id: &str,
    requested: &Url,
) -> Result<Option<CredentialRecord>, String> {
    if current_id == target_id {
        return Err("Current and target workspaces must be different".to_string());
    }

    // Preflight the target before any snapshot or credential write. A missing
    // target record intentionally represents a URL-only/session workspace.
    let target = backend.read_workspace(target_id)?;
    let next = match target {
        Some(record) if same_base(&record.base_url, requested.as_str()) => Some(record),
        Some(_) => {
            return Err(
                "Saved workspace credential is bound to a different API URL; re-enter it"
                    .to_string(),
            )
        }
        None => None,
    };

    // Capture every independently-persisted piece before mutation. This lets
    // an Err retain the strong meaning "the previous credential is active."
    let snapshot = WorkspaceSwitchSnapshot {
        cached: backend.read_cached()?,
        active: backend.read_active()?,
        disabled: backend.read_disabled_marker()?,
        current_workspace: backend.read_workspace(current_id)?,
    };
    let current = snapshot.cached.clone().or_else(|| snapshot.active.clone());

    let activation = (|| -> Result<(), String> {
        if let Some(record) = &current {
            backend.write_workspace(current_id, record)?;
        }
        match &next {
            Some(record) => {
                backend.write_active(record)?;
                backend.clear_disabled_marker()?;
            }
            None => {
                backend.write_disabled_marker()?;
                backend.delete_active()?;
            }
        }
        backend.replace_cached(next.clone())
    })();

    if let Err(error) = activation {
        let rollback_failures = restore_workspace_switch(backend, current_id, &snapshot);
        if rollback_failures.is_empty() {
            return Err(format!(
                "Workspace credential switch failed and was rolled back: {error}"
            ));
        }

        let fail_closed_failures = force_workspace_switch_fail_closed(backend);
        let fail_closed_detail = if fail_closed_failures.is_empty() {
            String::new()
        } else {
            format!(
                " Fail-closed cleanup also reported: {}.",
                fail_closed_failures.join("; ")
            )
        };
        return Err(format!(
            "{WORKSPACE_SWITCH_FATAL_PREFIX}: activation failed ({error}); rollback was incomplete ({}). Native API transport is disabled; restart Moosewave before reconnecting the workspace.{fail_closed_detail}",
            rollback_failures.join("; ")
        ));
    }

    Ok(next)
}

#[tauri::command]
pub fn api_broker_initialize(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    base_url: String,
    legacy_api_key: Option<String>,
) -> Result<BrokerStatus, String> {
    ensure_main_bundled_window(&window, "API broker")?;
    let requested_base = validate_base_url(&base_url)?;
    let _transaction = state.lock_credential_transaction()?;
    if state.ephemeral_demo {
        let record = state
            .cached()?
            .ok_or_else(|| "The local demo credential is unavailable".to_string())?;
        if !same_base(&record.base_url, requested_base.as_str()) {
            return Err("The local demo API URL does not match the launcher".to_string());
        }
        return Ok(status_for(Some(&record), false));
    }
    if credential_is_disabled(&app)? {
        state.replace_cached(None)?;
        let _ = delete_account(ACTIVE_ACCOUNT);
        let _ = delete_legacy_account(LEGACY_ACTIVE_ACCOUNT);
        return Ok(status_for(None, false));
    }

    if let Some(record) = read_record(ACTIVE_ACCOUNT)? {
        state.replace_cached(Some(record.clone()))?;
        delete_legacy_account(LEGACY_ACTIVE_ACCOUNT)?;
        return Ok(status_for(Some(&record), false));
    }

    // A plaintext localStorage credential from an older build is already in
    // renderer memory. Move it into the bound v2 record once, then callers
    // immediately erase the legacy copy. It is never returned over IPC.
    if let Some(secret) = normalize_secret(legacy_api_key)? {
        let record = record_for(&requested_base, secret);
        write_record(ACTIVE_ACCOUNT, &record)?;
        delete_legacy_account(LEGACY_ACTIVE_ACCOUNT)?;
        state.replace_cached(Some(record.clone()))?;
        return Ok(status_for(Some(&record), false));
    }

    // Raw keychain entries created by older versions did not bind a key to
    // an origin. Migrate only the compiled hosted origin; custom/self-hosted
    // users must re-enter once, otherwise compromised renderer storage could
    // silently bind the old key to an attacker-controlled URL.
    if let Some(secret) = read_legacy_secret(LEGACY_ACTIVE_ACCOUNT)? {
        if is_trusted_legacy_migration_base(&requested_base) {
            let record = record_for(&requested_base, secret);
            write_record(ACTIVE_ACCOUNT, &record)?;
            delete_legacy_account(LEGACY_ACTIVE_ACCOUNT)?;
            state.replace_cached(Some(record.clone()))?;
            return Ok(status_for(Some(&record), false));
        }
        state.replace_cached(None)?;
        return Ok(status_for(None, true));
    }

    state.replace_cached(None)?;
    Ok(status_for(None, false))
}

/// Accept a process-only demo bearer exclusively in debug builds. The value
/// is never persisted and the ordinary production broker remains Keychain /
/// Credential Manager backed.
#[cfg(debug_assertions)]
fn demo_credential_from_env() -> Option<CredentialRecord> {
    if std::env::var("POSTWAVE_DESKTOP_DEMO").ok().as_deref() != Some("1") {
        return None;
    }
    let base = std::env::var("POSTWAVE_DESKTOP_DEMO_API_URL").ok()?;
    let bearer = std::env::var("POSTWAVE_DESKTOP_DEMO_API_KEY").ok()?;
    let base = validate_base_url(&base).ok()?;
    let bearer = normalize_secret(Some(bearer)).ok()??;
    Some(record_for(&base, bearer))
}

#[tauri::command]
pub fn api_broker_configure(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    base_url: String,
    api_key: Option<String>,
    preserve_existing: bool,
) -> Result<BrokerStatus, String> {
    ensure_main_bundled_window(&window, "API broker")?;
    let base = validate_base_url(&base_url)?;
    let supplied = normalize_secret(api_key)?;
    let _transaction = state.lock_credential_transaction()?;

    let next = if let Some(secret) = supplied {
        Some(record_for(&base, secret))
    } else if preserve_existing {
        let current = state.cached_or_keyring_unlocked()?;
        match current {
            Some(record) if same_base(&record.base_url, base.as_str()) => Some(record),
            Some(_) => {
                return Err(
                    "Re-enter the API key when changing the API URL; stored credentials are origin-bound"
                        .to_string(),
                )
            }
            None => None,
        }
    } else {
        None
    };

    match &next {
        Some(record) => {
            write_record(ACTIVE_ACCOUNT, record)?;
            clear_disabled_marker(&app)?;
        }
        None => {
            write_disabled_marker(&app)?;
            delete_account(ACTIVE_ACCOUNT)?;
        }
    }
    delete_legacy_account(LEGACY_ACTIVE_ACCOUNT)?;
    state.replace_cached(next.clone())?;
    Ok(status_for(next.as_ref(), false))
}

#[tauri::command]
pub fn api_broker_clear(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "API broker")?;
    let _transaction = state.lock_credential_transaction()?;
    // Drop the process-held credential even if the OS vault is temporarily
    // unavailable. The marker prevents a stale keychain entry from being
    // restored on restart; a later explicit configure/switch removes it.
    state.replace_cached(None)?;
    write_disabled_marker(&app)?;
    let active_result = delete_account(ACTIVE_ACCOUNT);
    let legacy_result = delete_legacy_account(LEGACY_ACTIVE_ACCOUNT);
    active_result.and(legacy_result)
}

#[tauri::command]
pub async fn api_broker_stream_request(
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    request: BrokerRequest,
    on_event: Channel,
) -> Result<BrokerResponseHead, String> {
    ensure_main_bundled_window(&window, "API broker")?;
    validate_request_id(&request.request_id)?;
    let record = state
        .cached_or_keyring()?
        .ok_or_else(|| "No native API credential is configured".to_string())?;
    let request_id = request.request_id.clone();
    let builder = build_request(&state.client, &record, request)?;
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = state
            .cancellations
            .lock()
            .map_err(|_| "API cancellation state is unavailable".to_string())?;
        if pending.contains_key(&request_id) {
            return Err("API request id is already active".to_string());
        }
        pending.insert(request_id.clone(), cancel_tx);
    }
    let response = tokio::select! {
        response = builder.send() => response
            .map_err(|error| format!("Native API request failed: {error}")),
        _ = &mut cancel_rx => Err("Native API request cancelled".to_string()),
    };
    let mut response = match response {
        Ok(response) => response,
        Err(error) => {
            remove_cancellation(&state.cancellations, &request_id);
            return Err(error);
        }
    };
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        remove_cancellation(&state.cancellations, &request_id);
        return Err("API response is too large".to_string());
    }
    let status = response.status();
    let head = BrokerResponseHead {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: response_headers(response.headers()),
    };
    let cancellations = Arc::clone(&state.cancellations);
    tauri::async_runtime::spawn(async move {
        let result = forward_response(&mut response, &on_event, &mut cancel_rx).await;
        remove_cancellation(&cancellations, &request_id);
        let signal = match result {
            Ok(()) => BrokerStreamSignal::Complete,
            Err(message) => BrokerStreamSignal::Error { message },
        };
        if let Ok(encoded) = serde_json::to_string(&signal) {
            let _ = on_event.send(InvokeResponseBody::Json(encoded));
        }
    });
    Ok(head)
}

/// Non-persisting setup probe. It is intentionally limited to health and
/// API-key self-info so initial custom-origin validation works under the exact CSP
/// without becoming a second general-purpose credential transport.
#[tauri::command]
pub async fn api_broker_probe(
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    request: BrokerProbeRequest,
) -> Result<BrokerResponse, String> {
    ensure_main_bundled_window(&window, "API broker")?;
    let base = validate_base_url(&request.base_url)?;
    let url = validate_probe_url(&base, &request.url)?;
    let bearer = normalize_secret(request.api_key)?.unwrap_or_default();
    execute_request(
        &state.client,
        &CredentialRecord {
            version: 2,
            base_url: base.as_str().trim_end_matches('/').to_string(),
            bearer,
        },
        BrokerRequest {
            request_id: "setup-probe".to_string(),
            url: url.to_string(),
            method: "GET".to_string(),
            headers: BTreeMap::from([("accept".to_string(), "application/json".to_string())]),
            body: Vec::new(),
            timeout_ms: request.timeout_ms,
        },
    )
    .await
}

fn validate_probe_url(base: &Url, raw: &str) -> Result<Url, String> {
    let url = validate_request_url(base.as_str(), raw)?;
    let prefix = if base.path() == "/" {
        "/api/".to_string()
    } else {
        format!("{}/api/", base.path().trim_end_matches('/'))
    };
    if url.query().is_some()
        || !matches!(
            url.path().strip_prefix(&prefix),
            Some("health" | "v1/api-keys/me")
        )
    {
        return Err("API setup probe only permits health and API-key self-info".to_string());
    }
    Ok(url)
}

#[tauri::command]
pub fn api_broker_cancel(
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    request_id: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "API broker")?;
    validate_request_id(&request_id)?;
    if let Some(sender) = state
        .cancellations
        .lock()
        .map_err(|_| "API cancellation state is unavailable".to_string())?
        .remove(&request_id)
    {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn api_workspace_store(
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    id: String,
    base_url: String,
    api_key: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "API broker")?;
    validate_workspace_id(&id)?;
    let base = validate_base_url(&base_url)?;
    let secret =
        normalize_secret(Some(api_key))?.ok_or_else(|| "API key is required".to_string())?;
    let _transaction = state.lock_credential_transaction()?;
    write_record(&workspace_account(&id), &record_for(&base, secret))?;
    delete_legacy_account(&legacy_workspace_account(&id))
}

#[tauri::command]
pub fn api_workspace_remove(
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    id: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "API broker")?;
    validate_workspace_id(&id)?;
    let _transaction = state.lock_credential_transaction()?;
    delete_account(&workspace_account(&id))?;
    delete_legacy_account(&legacy_workspace_account(&id))
}

#[tauri::command]
pub fn api_workspace_status(
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    workspaces: Vec<WorkspaceDescriptor>,
) -> Result<Vec<WorkspaceCredentialStatus>, String> {
    ensure_main_bundled_window(&window, "API broker")?;
    if workspaces.len() > 20 {
        return Err("too many workspaces".to_string());
    }
    let _transaction = state.lock_credential_transaction()?;
    workspaces
        .into_iter()
        .map(|workspace| {
            validate_workspace_id(&workspace.id)?;
            let requested = validate_base_url(&workspace.base_url)?;
            let mut record = read_record(&workspace_account(&workspace.id))?;
            let legacy_account = legacy_workspace_account(&workspace.id);
            let legacy = if record.is_none() {
                read_legacy_secret(&legacy_account)?
            } else {
                None
            };
            let had_legacy = legacy.is_some();
            if let Some(secret) = legacy {
                if is_trusted_legacy_migration_base(&requested) {
                    let migrated = record_for(&requested, secret);
                    write_record(&workspace_account(&workspace.id), &migrated)?;
                    delete_legacy_account(&legacy_account)?;
                    record = Some(migrated);
                }
            }
            let configured = record
                .as_ref()
                .is_some_and(|saved| same_base(&saved.base_url, requested.as_str()));
            let legacy_reentry_required = !configured && had_legacy;
            Ok(WorkspaceCredentialStatus {
                id: workspace.id,
                configured,
                legacy_reentry_required,
            })
        })
        .collect()
}

#[tauri::command]
pub fn api_workspace_switch(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, ApiBrokerState>,
    current_id: String,
    target_id: String,
    target_base_url: String,
) -> Result<BrokerStatus, String> {
    ensure_main_bundled_window(&window, "API broker")?;
    validate_workspace_id(&current_id)?;
    validate_workspace_id(&target_id)?;
    let requested = validate_base_url(&target_base_url)?;
    let _transaction = state.lock_credential_transaction()?;
    let mut backend = NativeWorkspaceSwitchBackend {
        app: &app,
        state: &state,
    };
    let next =
        perform_workspace_switch_transaction(&mut backend, &current_id, &target_id, &requested)?;
    Ok(status_for(next.as_ref(), false))
}

async fn execute_request(
    client: &reqwest::Client,
    record: &CredentialRecord,
    request: BrokerRequest,
) -> Result<BrokerResponse, String> {
    let mut response = build_request(client, record, request)?
        .send()
        .await
        .map_err(|error| format!("Native API request failed: {error}"))?;
    let status = response.status();
    let response_headers = response_headers(response.headers());
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err("API response is too large".to_string());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Native API response failed: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err("API response is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(BrokerResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: response_headers,
        body,
    })
}

fn build_request(
    client: &reqwest::Client,
    record: &CredentialRecord,
    request: BrokerRequest,
) -> Result<reqwest::RequestBuilder, String> {
    if request.body.len() > MAX_REQUEST_BYTES {
        return Err("API request body is too large".to_string());
    }
    let url = validate_request_url(&record.base_url, &request.url)?;
    let method = validate_method(&request.method)?;
    let mut headers = validate_headers(request.headers)?;
    if !record.bearer.is_empty() {
        let bearer = if record.bearer.starts_with("pw_") {
            record.bearer.clone()
        } else {
            format!("pw_{}", record.bearer)
        };
        headers.insert(
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {bearer}"))
                .map_err(|_| "stored API credential is invalid".to_string())?,
        );
    }
    headers.insert(
        HeaderName::from_static("x-postwave-client"),
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        HeaderName::from_static("x-postwave-version"),
        HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(crate::session_broker::native_user_agent()),
    );

    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let mut builder = client
        .request(method, url)
        .headers(headers)
        .timeout(Duration::from_millis(timeout_ms));
    if !request.body.is_empty() {
        builder = builder.body(request.body);
    }
    Ok(builder)
}

async fn forward_response(
    response: &mut reqwest::Response,
    on_event: &Channel,
    cancel_rx: &mut tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let mut received = 0usize;
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk
                .map_err(|error| format!("Native API response failed: {error}"))?,
            _ = &mut *cancel_rx => return Err("Native API request cancelled".to_string()),
        };
        let Some(chunk) = chunk else { return Ok(()) };
        received = received.saturating_add(chunk.len());
        if received > MAX_RESPONSE_BYTES {
            return Err("API response is too large".to_string());
        }
        on_event
            .send(InvokeResponseBody::Raw(chunk.to_vec()))
            .map_err(|error| format!("Could not stream native API response: {error}"))?;
    }
}

fn remove_cancellation(
    cancellations: &Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
    request_id: &str,
) {
    if let Ok(mut values) = cancellations.lock() {
        values.remove(request_id);
    }
}

pub(crate) fn validate_base_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "invalid API URL".to_string())?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("API URL must not contain credentials, a query, or a fragment".to_string());
    }
    match url.scheme() {
        "https" => {}
        // Plain HTTP is safe only for an API bound to this machine. This is
        // also required by packaged local-demo/self-hosted installs, whose
        // release broker must enforce the same loopback exception as the
        // renderer URL validator.
        "http" if is_loopback(url.host_str()) => {}
        _ => return Err("API URL must use HTTPS".to_string()),
    }
    if url.host_str().is_none() {
        return Err("API URL must include a host".to_string());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url)
}

pub(crate) fn validate_request_url(base_raw: &str, request_raw: &str) -> Result<Url, String> {
    let base = validate_base_url(base_raw)?;
    let request = Url::parse(request_raw).map_err(|_| "invalid API request URL".to_string())?;
    if request.username() != "" || request.password().is_some() || request.fragment().is_some() {
        return Err("unsafe API request URL".to_string());
    }
    if request.scheme() != base.scheme()
        || request.host_str().map(str::to_ascii_lowercase)
            != base.host_str().map(str::to_ascii_lowercase)
        || request.port_or_known_default() != base.port_or_known_default()
    {
        return Err("API request origin does not match the credential binding".to_string());
    }
    let api_prefix = if base.path() == "/" {
        "/api/".to_string()
    } else {
        format!("{}/api/", base.path().trim_end_matches('/'))
    };
    if !request.path().starts_with(&api_prefix) {
        return Err("Native API broker only permits the configured /api/ routes".to_string());
    }
    Ok(request)
}

pub(crate) fn validate_method(raw: &str) -> Result<reqwest::Method, String> {
    let upper = raw.trim().to_ascii_uppercase();
    if !matches!(
        upper.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err("unsupported API request method".to_string());
    }
    reqwest::Method::from_bytes(upper.as_bytes()).map_err(|_| "invalid method".to_string())
}

pub(crate) fn validate_headers(values: BTreeMap<String, String>) -> Result<HeaderMap, String> {
    if values.len() > MAX_HEADERS {
        return Err("too many API request headers".to_string());
    }
    let mut total = 0usize;
    let mut headers = HeaderMap::new();
    for (raw_name, raw_value) in values {
        total = total
            .saturating_add(raw_name.len())
            .saturating_add(raw_value.len());
        if total > MAX_HEADER_BYTES || raw_value.contains(['\r', '\n']) {
            return Err("invalid API request headers".to_string());
        }
        let name = HeaderName::from_bytes(raw_name.as_bytes())
            .map_err(|_| "invalid API request header name".to_string())?;
        let lower = name.as_str();
        if is_forbidden_request_header(lower) {
            return Err(format!("renderer may not set {lower}"));
        }
        let value = HeaderValue::from_str(&raw_value)
            .map_err(|_| "invalid API request header value".to_string())?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn is_forbidden_request_header(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "host"
            | "origin"
            | "referer"
            | "forwarded"
            | "via"
            | "cf-connecting-ip"
            | "true-client-ip"
            | "fastly-client-ip"
            | "fly-client-ip"
            | "x-real-ip"
            | "x-client-ip"
            | "x-cluster-client-ip"
            | "x-envoy-external-address"
            | "x-appengine-user-ip"
            | "x-azure-clientip"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "proxy-connection"
            | "keep-alive"
            | "te"
            | "trailer"
            | "upgrade"
            | "x-http-method-override"
            | "x-method-override"
            | "x-original-url"
            | "x-rewrite-url"
            | "user-agent"
            | "x-postwave-client"
            | "x-postwave-version"
    ) || name.starts_with("sec-")
        || name.starts_with("x-forwarded-")
        || name.starts_with("x-original-forwarded-")
}

pub(crate) fn response_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    const ALLOWED: &[&str] = &[
        "content-type",
        "content-disposition",
        "content-language",
        "etag",
        "last-modified",
        "retry-after",
        "cache-control",
        "expires",
        "accept-ranges",
        "content-range",
        "x-request-id",
        "x-postwave-request-id",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        // The context epoch. Without this line the header is stripped by the
        // broker and NEVER reaches the TypeScript side, so desktop's entire
        // observe/stamp/refuse/cache-drop chain is inert in a packaged build
        // while every unit test and the wiring guard stay green — they all run
        // against `fetch`, not against this allowlist.
        "x-postwave-context-epoch",
    ];
    headers
        .iter()
        .filter(|(name, _)| ALLOWED.contains(&name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

fn record_for(base: &Url, bearer: String) -> CredentialRecord {
    CredentialRecord {
        version: 2,
        base_url: base.as_str().trim_end_matches('/').to_string(),
        bearer,
    }
}

fn status_for(record: Option<&CredentialRecord>, legacy_reentry_required: bool) -> BrokerStatus {
    BrokerStatus {
        configured: record.is_some(),
        base_url: record.map(|value| value.base_url.clone()),
        credential_fingerprint: record.map(credential_fingerprint),
        legacy_reentry_required,
    }
}

fn credential_fingerprint(record: &CredentialRecord) -> String {
    let mut digest = Sha256::new();
    digest.update(b"postwave-desktop-api-credential-v1\0");
    digest.update(record.base_url.as_bytes());
    digest.update(b"\0");
    digest.update(record.bearer.as_bytes());
    format!("{:x}", digest.finalize())
}

fn normalize_secret(value: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else { return Ok(None) };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > MAX_SECRET_BYTES || trimmed.chars().any(char::is_control) {
        return Err("invalid API key".to_string());
    }
    Ok(Some(trimmed.to_string()))
}

fn same_base(left: &str, right: &str) -> bool {
    match (validate_base_url(left), validate_base_url(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_loopback(host: Option<&str>) -> bool {
    matches!(
        host.map(str::to_ascii_lowercase).as_deref(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    )
}

fn is_trusted_legacy_migration_base(base: &Url) -> bool {
    base.scheme() == "https"
        && base
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("api.moosewave.com"))
        && base.port_or_known_default() == Some(443)
        && base.path() == "/"
}

fn validate_workspace_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
    {
        return Ok(());
    }
    Err("invalid workspace id".to_string())
}

fn validate_request_id(id: &str) -> Result<(), String> {
    if !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '-' | '_'))
    {
        Ok(())
    } else {
        Err("invalid API request id".to_string())
    }
}

fn workspace_account(id: &str) -> String {
    format!("{WORKSPACE_ACCOUNT_PREFIX}{id}")
}

fn legacy_workspace_account(id: &str) -> String {
    format!("{LEGACY_WORKSPACE_PREFIX}{id}")
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, account).map_err(|error| error.to_string())
}

fn write_record(account: &str, record: &CredentialRecord) -> Result<(), String> {
    let encoded = serde_json::to_string(record).map_err(|error| error.to_string())?;
    entry(account)?
        .set_password(&encoded)
        .map_err(|error| error.to_string())
}

fn read_record(account: &str) -> Result<Option<CredentialRecord>, String> {
    match entry(account)?.get_password() {
        Ok(encoded) => {
            let record: CredentialRecord = serde_json::from_str(&encoded)
                .map_err(|_| "stored API credential is corrupt".to_string())?;
            if record.version != 2 || normalize_secret(Some(record.bearer.clone()))?.is_none() {
                return Err("stored API credential is invalid".to_string());
            }
            validate_base_url(&record.base_url)?;
            Ok(Some(record))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_legacy_secret(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(value) => normalize_secret(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn delete_account(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn delete_legacy_account(account: &str) -> Result<(), String> {
    delete_account(account)
}

fn disabled_marker_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(DISABLED_MARKER))
}

fn credential_is_disabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    disabled_marker_path(app)?
        .try_exists()
        .map_err(|error| error.to_string())
}

fn write_disabled_marker<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let path = disabled_marker_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "invalid credential marker path".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut marker = options.open(&path).map_err(|error| error.to_string())?;
    marker
        .write_all(b"disabled\n")
        .map_err(|error| error.to_string())?;
    marker.sync_all().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn clear_disabled_marker<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    match fs::remove_file(disabled_marker_path(app)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn record() -> CredentialRecord {
        record_for(
            &validate_base_url("https://api.moosewave.com").unwrap(),
            "top-secret".to_string(),
        )
    }

    fn credential(base_url: &str, bearer: &str) -> CredentialRecord {
        record_for(&validate_base_url(base_url).unwrap(), bearer.to_string())
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    enum SwitchOperation {
        ReadTarget,
        ReadCurrent,
        WriteWorkspace,
        DeleteWorkspace,
        WriteActive,
        DeleteActive,
        ReadMarker,
        WriteMarker,
        ClearMarker,
        ReplaceCache,
    }

    #[derive(Clone, Copy, Debug)]
    enum FailureTiming {
        Before,
        After,
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct FakeSwitchState {
        cached: Option<CredentialRecord>,
        active: Option<CredentialRecord>,
        disabled: bool,
        workspaces: HashMap<String, CredentialRecord>,
        inconsistent: bool,
    }

    struct FakeWorkspaceSwitchBackend {
        cached: Option<CredentialRecord>,
        active: Option<CredentialRecord>,
        disabled: bool,
        workspaces: HashMap<String, CredentialRecord>,
        failures: HashMap<SwitchOperation, VecDeque<FailureTiming>>,
        mutations: Vec<SwitchOperation>,
        inconsistent: bool,
    }

    impl FakeWorkspaceSwitchBackend {
        fn configured_target(disabled: bool) -> Self {
            Self {
                cached: Some(credential("https://current.test", "current-secret")),
                active: Some(credential("https://current.test", "current-secret")),
                disabled,
                workspaces: HashMap::from([
                    (
                        "current".to_string(),
                        credential("https://current.test", "older-current-secret"),
                    ),
                    (
                        "target".to_string(),
                        credential("https://target.test", "target-secret"),
                    ),
                ]),
                failures: HashMap::new(),
                mutations: Vec::new(),
                inconsistent: false,
            }
        }

        fn url_only_target() -> Self {
            let mut backend = Self::configured_target(false);
            backend.workspaces.remove("target");
            backend
        }

        fn snapshot(&self) -> FakeSwitchState {
            FakeSwitchState {
                cached: self.cached.clone(),
                active: self.active.clone(),
                disabled: self.disabled,
                workspaces: self.workspaces.clone(),
                inconsistent: self.inconsistent,
            }
        }

        fn fail_on(&mut self, operation: SwitchOperation, timing: FailureTiming) {
            self.failures
                .entry(operation)
                .or_default()
                .push_back(timing);
        }

        fn begin(&mut self, operation: SwitchOperation) -> Result<Option<FailureTiming>, String> {
            let timing = self
                .failures
                .get_mut(&operation)
                .and_then(VecDeque::pop_front);
            if matches!(timing, Some(FailureTiming::Before)) {
                Err(format!("injected {operation:?} failure before mutation"))
            } else {
                Ok(timing)
            }
        }

        fn finish(operation: SwitchOperation, timing: Option<FailureTiming>) -> Result<(), String> {
            if matches!(timing, Some(FailureTiming::After)) {
                Err(format!("injected {operation:?} failure after mutation"))
            } else {
                Ok(())
            }
        }
    }

    impl WorkspaceSwitchBackend for FakeWorkspaceSwitchBackend {
        fn read_cached(&mut self) -> Result<Option<CredentialRecord>, String> {
            Ok(self.cached.clone())
        }

        fn replace_cached(&mut self, value: Option<CredentialRecord>) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::ReplaceCache)?;
            self.mutations.push(SwitchOperation::ReplaceCache);
            self.cached = value;
            Self::finish(SwitchOperation::ReplaceCache, timing)
        }

        fn read_active(&mut self) -> Result<Option<CredentialRecord>, String> {
            Ok(self.active.clone())
        }

        fn write_active(&mut self, record: &CredentialRecord) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::WriteActive)?;
            self.mutations.push(SwitchOperation::WriteActive);
            self.active = Some(record.clone());
            Self::finish(SwitchOperation::WriteActive, timing)
        }

        fn delete_active(&mut self) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::DeleteActive)?;
            self.mutations.push(SwitchOperation::DeleteActive);
            self.active = None;
            Self::finish(SwitchOperation::DeleteActive, timing)
        }

        fn read_disabled_marker(&mut self) -> Result<bool, String> {
            let timing = self.begin(SwitchOperation::ReadMarker)?;
            Self::finish(SwitchOperation::ReadMarker, timing)?;
            Ok(self.disabled)
        }

        fn write_disabled_marker(&mut self) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::WriteMarker)?;
            self.mutations.push(SwitchOperation::WriteMarker);
            self.disabled = true;
            Self::finish(SwitchOperation::WriteMarker, timing)
        }

        fn clear_disabled_marker(&mut self) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::ClearMarker)?;
            self.mutations.push(SwitchOperation::ClearMarker);
            self.disabled = false;
            Self::finish(SwitchOperation::ClearMarker, timing)
        }

        fn read_workspace(&mut self, id: &str) -> Result<Option<CredentialRecord>, String> {
            let operation = if id == "target" {
                SwitchOperation::ReadTarget
            } else {
                SwitchOperation::ReadCurrent
            };
            let timing = self.begin(operation)?;
            Self::finish(operation, timing)?;
            Ok(self.workspaces.get(id).cloned())
        }

        fn write_workspace(&mut self, id: &str, record: &CredentialRecord) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::WriteWorkspace)?;
            self.mutations.push(SwitchOperation::WriteWorkspace);
            self.workspaces.insert(id.to_string(), record.clone());
            Self::finish(SwitchOperation::WriteWorkspace, timing)
        }

        fn delete_workspace(&mut self, id: &str) -> Result<(), String> {
            let timing = self.begin(SwitchOperation::DeleteWorkspace)?;
            self.mutations.push(SwitchOperation::DeleteWorkspace);
            self.workspaces.remove(id);
            Self::finish(SwitchOperation::DeleteWorkspace, timing)
        }

        fn mark_inconsistent(&mut self) {
            self.inconsistent = true;
        }
    }

    fn run_fake_workspace_switch(
        backend: &mut FakeWorkspaceSwitchBackend,
    ) -> Result<Option<CredentialRecord>, String> {
        perform_workspace_switch_transaction(
            backend,
            "current",
            "target",
            &validate_base_url("https://target.test").unwrap(),
        )
    }

    fn assert_injected_failure_rolls_back(
        mut backend: FakeWorkspaceSwitchBackend,
        operation: SwitchOperation,
    ) {
        let before = backend.snapshot();
        backend.fail_on(operation, FailureTiming::After);

        let error = run_fake_workspace_switch(&mut backend).unwrap_err();

        assert!(error.contains("was rolled back"), "{error}");
        assert!(!error.contains(WORKSPACE_SWITCH_FATAL_PREFIX), "{error}");
        assert_eq!(backend.snapshot(), before);
    }

    #[test]
    fn workspace_switch_preflights_target_before_any_write() {
        let mut backend = FakeWorkspaceSwitchBackend::configured_target(false);
        let before = backend.snapshot();
        backend.fail_on(SwitchOperation::ReadTarget, FailureTiming::Before);

        let error = run_fake_workspace_switch(&mut backend).unwrap_err();

        assert!(error.contains("ReadTarget"), "{error}");
        assert_eq!(backend.snapshot(), before);
        assert!(backend.mutations.is_empty());
    }

    #[test]
    fn workspace_switch_rejects_target_origin_mismatch_before_any_write() {
        let mut backend = FakeWorkspaceSwitchBackend::configured_target(false);
        backend.workspaces.insert(
            "target".to_string(),
            credential("https://other-target.test", "target-secret"),
        );
        let before = backend.snapshot();

        let error = run_fake_workspace_switch(&mut backend).unwrap_err();

        assert!(error.contains("different API URL"), "{error}");
        assert_eq!(backend.snapshot(), before);
        assert!(backend.mutations.is_empty());
    }

    #[test]
    fn workspace_switch_rolls_back_current_snapshot_write_failure() {
        assert_injected_failure_rolls_back(
            FakeWorkspaceSwitchBackend::configured_target(false),
            SwitchOperation::WriteWorkspace,
        );
    }

    #[test]
    fn workspace_switch_rolls_back_active_write_failure() {
        assert_injected_failure_rolls_back(
            FakeWorkspaceSwitchBackend::configured_target(false),
            SwitchOperation::WriteActive,
        );
    }

    #[test]
    fn workspace_switch_rolls_back_active_delete_failure() {
        assert_injected_failure_rolls_back(
            FakeWorkspaceSwitchBackend::url_only_target(),
            SwitchOperation::DeleteActive,
        );
    }

    #[test]
    fn workspace_switch_rolls_back_marker_clear_failure() {
        assert_injected_failure_rolls_back(
            FakeWorkspaceSwitchBackend::configured_target(true),
            SwitchOperation::ClearMarker,
        );
    }

    #[test]
    fn workspace_switch_rolls_back_marker_write_failure() {
        assert_injected_failure_rolls_back(
            FakeWorkspaceSwitchBackend::url_only_target(),
            SwitchOperation::WriteMarker,
        );
    }

    #[test]
    fn workspace_switch_rolls_back_cache_replacement_failure() {
        assert_injected_failure_rolls_back(
            FakeWorkspaceSwitchBackend::configured_target(false),
            SwitchOperation::ReplaceCache,
        );
    }

    #[test]
    fn workspace_switch_rollback_failure_is_fatal_and_fails_closed() {
        let mut backend = FakeWorkspaceSwitchBackend::configured_target(false);
        let previous = backend.cached.clone().unwrap();
        backend.fail_on(SwitchOperation::WriteActive, FailureTiming::After);
        backend.fail_on(SwitchOperation::WriteActive, FailureTiming::Before);

        let error = run_fake_workspace_switch(&mut backend).unwrap_err();

        assert!(error.starts_with(WORKSPACE_SWITCH_FATAL_PREFIX), "{error}");
        assert!(backend.inconsistent);
        assert!(backend.disabled);
        assert!(backend.active.is_none());
        assert!(backend.cached.is_none());
        assert_eq!(backend.workspaces.get("current"), Some(&previous));
    }

    #[test]
    fn fatal_credential_state_blocks_native_transport_until_restart() {
        let state = ApiBrokerState::new();
        state
            .replace_cached(Some(credential("https://current.test", "current-secret")))
            .unwrap();

        state.mark_credential_inconsistent();

        let read_error = state.cached_or_keyring().unwrap_err();
        assert!(read_error.contains("inconsistent"), "{read_error}");
        assert!(state.lock_credential_transaction().is_err());
    }

    #[test]
    fn workspace_switch_commits_configured_and_url_only_targets() {
        let mut configured = FakeWorkspaceSwitchBackend::configured_target(true);
        let previous = configured.cached.clone().unwrap();
        let target = configured.workspaces.get("target").cloned().unwrap();
        assert_eq!(
            run_fake_workspace_switch(&mut configured),
            Ok(Some(target.clone()))
        );
        assert_eq!(configured.active, Some(target.clone()));
        assert_eq!(configured.cached, Some(target));
        assert!(!configured.disabled);
        assert_eq!(configured.workspaces.get("current"), Some(&previous));

        let mut url_only = FakeWorkspaceSwitchBackend::url_only_target();
        let previous = url_only.cached.clone().unwrap();
        assert_eq!(run_fake_workspace_switch(&mut url_only), Ok(None));
        assert!(url_only.active.is_none());
        assert!(url_only.cached.is_none());
        assert!(url_only.disabled);
        assert_eq!(url_only.workspaces.get("current"), Some(&previous));
    }

    #[test]
    fn credentials_are_bound_to_an_exact_origin_and_api_path() {
        assert!(validate_request_url(
            &record().base_url,
            "https://api.moosewave.com/api/v1/campaigns?limit=1"
        )
        .is_ok());
        assert!(
            validate_request_url(&record().base_url, "https://evil.example/api/v1/campaigns")
                .is_err()
        );
        assert!(validate_request_url(
            &record().base_url,
            "https://api.moosewave.com.evil.example/api/v1/campaigns"
        )
        .is_err());
        assert!(validate_request_url(
            &record().base_url,
            "https://api.moosewave.com/oauth/callback"
        )
        .is_err());
        assert!(validate_request_url(
            "https://self-hosted.example",
            "https://self-hosted.example/api/v1/me"
        )
        .is_ok());
        assert!(validate_request_url(
            "https://self-hosted.example/postwave",
            "https://self-hosted.example/postwave/api/v1/me"
        )
        .is_ok());
        assert!(validate_request_url(
            "https://self-hosted.example/postwave",
            "https://self-hosted.example/api/v1/me"
        )
        .is_err());
    }

    #[test]
    fn renderer_cannot_supply_credential_or_transport_headers() {
        for name in [
            "authorization",
            "Authorization",
            "cookie",
            "proxy-authorization",
            "host",
            "origin",
            "content-length",
            "sec-fetch-site",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-forwarded-port",
            "x-real-ip",
            "cf-connecting-ip",
            "true-client-ip",
            "x-envoy-external-address",
            "user-agent",
            "x-postwave-client",
            "x-postwave-version",
        ] {
            let mut headers = BTreeMap::new();
            headers.insert(name.to_string(), "attacker".to_string());
            assert!(validate_headers(headers).is_err(), "accepted {name}");
        }
    }

    #[test]
    fn status_serialization_never_contains_the_bearer() {
        let status = status_for(Some(&record()), false);
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(encoded.contains("api.moosewave.com"));
        assert!(!encoded.contains("top-secret"));
        assert!(!encoded.contains("bearer"));
        assert_eq!(status.credential_fingerprint.as_deref().unwrap().len(), 64);
        let other = status_for(
            Some(&CredentialRecord {
                bearer: "a-different-secret".to_string(),
                ..record()
            }),
            false,
        );
        assert_ne!(status.credential_fingerprint, other.credential_fingerprint);
    }

    #[test]
    fn production_bases_require_tls_except_for_loopback() {
        assert!(validate_base_url("https://api.moosewave.com").is_ok());
        assert!(validate_base_url("http://localhost:8080").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080").is_ok());
        assert!(validate_base_url("http://[::1]:8080").is_ok());
        assert!(validate_base_url("http://api.moosewave.com").is_err());
        assert!(validate_base_url("https://user:pass@api.moosewave.com").is_err());
        assert!(validate_base_url("https://api.moosewave.com?next=evil").is_err());
        assert!(is_trusted_legacy_migration_base(
            &validate_base_url("https://api.moosewave.com").unwrap()
        ));
        // Retired DNS origins are never eligible for credential migration.
        assert!(!is_trusted_legacy_migration_base(
            &validate_base_url("https://api.legacy.invalid").unwrap()
        ));
        assert!(!is_trusted_legacy_migration_base(
            &validate_base_url("https://api.moosewave.com/untrusted-prefix").unwrap()
        ));
    }

    #[test]
    fn setup_probe_is_not_a_general_authenticated_transport() {
        let base = validate_base_url("https://self-hosted.example/gateway").unwrap();
        assert!(
            validate_probe_url(&base, "https://self-hosted.example/gateway/api/health").is_ok()
        );
        assert!(validate_probe_url(
            &base,
            "https://self-hosted.example/gateway/api/v1/api-keys/me"
        )
        .is_ok());
        assert!(validate_probe_url(
            &base,
            "https://self-hosted.example/gateway/api/v1/campaigns"
        )
        .is_err());
        assert!(
            validate_probe_url(&base, "https://attacker.example/gateway/api/v1/api-keys/me")
                .is_err()
        );
    }

    #[test]
    fn workspace_ids_are_strictly_bounded() {
        assert!(validate_workspace_id("default").is_ok());
        assert!(validate_workspace_id("a-b_c9").is_ok());
        assert!(validate_workspace_id("../escape").is_err());
        assert!(validate_workspace_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn broker_injects_auth_once_and_never_follows_redirects() {
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let target_url = format!("http://{}", redirect_target.local_addr().unwrap());
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_url = format!("http://{}", source.local_addr().unwrap());
        let (seen_tx, seen_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = vec![0u8; 16 * 1024];
            let count = stream.read(&mut bytes).unwrap();
            seen_tx
                .send(String::from_utf8_lossy(&bytes[..count]).to_string())
                .unwrap();
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: {target_url}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
        });
        let record = CredentialRecord {
            version: 2,
            base_url: source_url.clone(),
            bearer: "redirect-secret".to_string(),
        };
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let response = tauri::async_runtime::block_on(execute_request(
            &client,
            &record,
            BrokerRequest {
                request_id: "redirect-test".to_string(),
                url: format!("{source_url}/api/v1/redirect"),
                method: "GET".to_string(),
                headers: BTreeMap::new(),
                body: Vec::new(),
                timeout_ms: Some(2_000),
            },
        ))
        .unwrap();
        server.join().unwrap();
        let wire = seen_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(response.status, 302);
        assert!(wire
            .to_ascii_lowercase()
            .contains("authorization: bearer pw_redirect-secret"));
        std::thread::sleep(Duration::from_millis(50));
        assert!(
            redirect_target.accept().is_err(),
            "redirect target received the bearer request"
        );
    }
}

#[cfg(test)]
mod loopback_predicate_tests {
    use super::is_loopback;
    use url::Url;

    /// What `Url::host_str()` actually yields decides which entries in the
    /// loopback allowlists are load-bearing and which are dead.
    ///
    /// The `url` crate serialises an IPv6 host WITH brackets, so `[::1]` is the
    /// form these predicates ever see and a bare `"::1"` entry never matches.
    /// That is worth pinning rather than remembering: `api_broker::is_loopback`
    /// lists both, `commands::is_loopback_host` lists only the bare form, and
    /// the difference is invisible until someone runs a local IPv6 API.
    #[test]
    fn host_str_brackets_ipv6() {
        assert_eq!(
            Url::parse("http://[::1]:8080/").unwrap().host_str(),
            Some("[::1]")
        );
        assert_eq!(
            Url::parse("http://127.0.0.1/").unwrap().host_str(),
            Some("127.0.0.1")
        );
    }

    /// The plain-HTTP exception is an ALLOWLIST, and must stay one.
    ///
    /// This is the same decision the MCP server's SSRF guard makes with a
    /// denylist of private ranges, and the contrast matters: a denylist has to
    /// enumerate every way to spell an internal address (that one missed
    /// `::ffff:127.0.0.1`), while an allowlist fails closed on anything it does
    /// not recognise. A mapped or alternate spelling here is REJECTED, which
    /// costs a local-dev convenience and cannot cost a credential.
    #[test]
    fn only_recognised_loopback_spellings_allow_plain_http() {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            assert!(is_loopback(Some(host)), "{host} should be loopback");
        }
        for host in [
            "example.com",
            "127.0.0.2",          // loopback in fact, not on the list
            "[::ffff:127.0.0.1]", // IPv4-mapped IPv6
            "0.0.0.0",
            "169.254.169.254",    // cloud metadata
            "localhost.evil.com", // suffix trick
            "",
        ] {
            assert!(!is_loopback(Some(host)), "{host} must not allow plain HTTP");
        }
        assert!(!is_loopback(None));
    }

    /// Plain HTTP is permitted only to loopback; everything else needs HTTPS.
    #[test]
    fn plain_http_is_confined_to_loopback() {
        assert!(super::validate_base_url("http://127.0.0.1:8080").is_ok());
        assert!(super::validate_base_url("http://[::1]:8080").is_ok());
        assert!(super::validate_base_url("http://api.moosewave.com").is_err());
        assert!(super::validate_base_url("http://[::ffff:127.0.0.1]:8080").is_err());
        assert!(super::validate_base_url("https://api.moosewave.com").is_ok());
    }

    /// A broker request must stay on the credential's own origin.
    ///
    /// The bearer is bound to a base URL; if a renderer could steer the request
    /// to another scheme, host or port, it would steer the token with it.
    #[test]
    fn request_url_cannot_leave_the_credential_origin() {
        let base = "https://api.moosewave.com";
        assert!(
            super::validate_request_url(base, "https://api.moosewave.com/api/v1/campaigns").is_ok()
        );

        for hostile in [
            "https://evil.com/api/v1/campaigns",              // other host
            "http://api.moosewave.com/api/v1/campaigns",       // downgraded scheme
            "https://api.moosewave.com:8443/api/v1/campaigns", // other port
            "https://api.moosewave.com/internal/secrets",      // outside /api/
            "https://user:pw@api.moosewave.com/api/v1/x",      // embedded credentials
            "https://api.moosewave.com/api/v1/x#frag",         // fragment
        ] {
            assert!(
                super::validate_request_url(base, hostile).is_err(),
                "{hostile} must be rejected"
            );
        }
    }
}
