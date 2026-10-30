//! Native cookie-session transport for the bundled desktop renderer.
//!
//! WebView cookie policy is intentionally not part of this transport. The
//! native process owns a tiny, origin-bound cookie jar and returns only normal
//! response metadata/body over IPC. In particular, `Set-Cookie` and `Cookie`
//! never cross the renderer boundary.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cookie::Cookie;
use reqwest::header::{HeaderName, HeaderValue, COOKIE, SET_COOKIE, USER_AGENT};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, WebviewWindow};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

use crate::api_broker::{
    response_headers, validate_base_url, validate_headers, validate_method, validate_request_url,
    BrokerRequest, BrokerResponseHead, BrokerStreamSignal,
};
use crate::ipc_guard::ensure_main_bundled_window;

const SECRET_SERVICE: &str = "com.moosewave.desktop";
const SESSION_ACCOUNT_PREFIX: &str = "auth_session_v1:";
const SESSION_INDEX_ACCOUNT: &str = "auth_session_index_v1";
const SESSION_GENERATION_ACCOUNT: &str = "auth_session_generation_v1";
const INITIAL_SESSION_GENERATION: &str = "initial-v1";
const SESSION_RECORD_VERSION: u8 = 1;
const MAX_COOKIE_VALUE_BYTES: usize = 8 * 1024;
// Windows Credential Manager caps generic credential blobs at 2.5 KiB. Keep
// both cookie records and the hashed-origin index below that common ceiling.
const MAX_COOKIE_RECORD_BYTES: usize = 2_400;
const MAX_COOKIE_COUNT: usize = 4;
const MAX_SESSION_ORIGINS: usize = 20;
const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_COOKIE_LIFETIME_SECONDS: i64 = 400 * 24 * 60 * 60;

const SESSION_COOKIE: &str = "pw_session";
const TRUST_COOKIE: &str = "pw_device_trust";
const WEBAUTHN_REGISTER_COOKIE: &str = "pw_wa_reg";
const WEBAUTHN_LOGIN_COOKIE: &str = "pw_wa_login";

#[derive(Clone, Serialize, Deserialize)]
struct StoredSessionCookie {
    name: String,
    value: String,
    path: String,
    secure: bool,
    /// None is a process-session cookie and is deliberately never persisted.
    expires_at: Option<i64>,
}

impl Drop for StoredSessionCookie {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedSessionRecord {
    version: u8,
    /// Hash-bound to the exact configured base without storing its URL.
    base_binding: String,
    /// A shared-device wipe rotates this value before best-effort deletion,
    /// making any undiscoverable orphan record unusable on the next launch.
    generation: String,
    cookies: Vec<StoredSessionCookie>,
}

#[derive(Default)]
struct SessionJars {
    loaded: HashSet<String>,
    cookies: HashMap<String, Vec<StoredSessionCookie>>,
    /// A shared-device wipe must remain authoritative in this process even if
    /// the OS credential manager rejected one of the best-effort deletions.
    block_persisted_loads: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBrokerStatus {
    pub base_url: String,
}

pub struct SessionBrokerState {
    client: reqwest::Client,
    active_base: RwLock<Option<Url>>,
    jars: Mutex<SessionJars>,
    ephemeral_demo: bool,
    cancellations: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
}

impl SessionBrokerState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("build native session client");
        #[cfg(debug_assertions)]
        let ephemeral_demo = std::env::var("POSTWAVE_DESKTOP_DEMO").ok().as_deref() == Some("1");
        #[cfg(not(debug_assertions))]
        let ephemeral_demo = false;
        Self {
            client,
            active_base: RwLock::new(None),
            jars: Mutex::new(SessionJars {
                block_persisted_loads: ephemeral_demo,
                ..SessionJars::default()
            }),
            ephemeral_demo,
            cancellations: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn active_base(&self) -> Result<Url, String> {
        self.active_base
            .read()
            .map_err(|_| "Native session origin state is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Native session transport is not initialized".to_string())
    }

    fn activate(&self, base: Url) -> Result<(), String> {
        let key = normalized_base(&base);
        {
            let mut jars = self
                .jars
                .lock()
                .map_err(|_| "Native session cookie state is unavailable".to_string())?;
            ensure_jar_loaded(&mut jars, &key)?;
            purge_expired_and_persist(&mut jars, &key)?;
        }
        *self
            .active_base
            .write()
            .map_err(|_| "Native session origin state is unavailable".to_string())? = Some(base);
        Ok(())
    }

    fn cookie_header(&self, base: &Url, request: &Url) -> Result<Option<HeaderValue>, String> {
        let key = normalized_base(base);
        let now = unix_now();
        let mut jars = self
            .jars
            .lock()
            .map_err(|_| "Native session cookie state is unavailable".to_string())?;
        ensure_jar_loaded(&mut jars, &key)?;
        let values = jars.cookies.entry(key.clone()).or_default();
        let before = values.len();
        values.retain(|cookie| !cookie_is_expired(cookie, now));
        if values.len() != before && !self.ephemeral_demo {
            persist_jar(&key, values)?;
        }
        let mut matching = values
            .iter()
            .filter(|cookie| {
                (!cookie.secure || request.scheme() == "https")
                    && cookie_path_matches(request.path(), &cookie.path)
            })
            .collect::<Vec<_>>();
        matching.sort_by(|left, right| right.path.len().cmp(&left.path.len()));
        if matching.is_empty() {
            return Ok(None);
        }
        let encoded = Zeroizing::new(
            matching
                .into_iter()
                .map(|cookie| format!("{}={}", cookie.name, cookie.value))
                .collect::<Vec<_>>()
                .join("; "),
        );
        HeaderValue::from_str(encoded.as_str())
            .map(Some)
            .map_err(|_| "Native session cookie state is invalid".to_string())
    }

    fn capture_response_cookies(
        &self,
        base: &Url,
        response_url: &Url,
        headers: &reqwest::header::HeaderMap,
    ) -> Result<(), String> {
        let key = normalized_base(base);
        let now = unix_now();
        let mut mutations = Vec::new();
        for value in headers.get_all(SET_COOKIE) {
            let Ok(raw) = value.to_str() else { continue };
            if let Some(mutation) = parse_cookie_mutation(base, response_url, raw, now)? {
                mutations.push(mutation);
            }
        }
        if mutations.is_empty() {
            return Ok(());
        }
        let mut jars = self
            .jars
            .lock()
            .map_err(|_| "Native session cookie state is unavailable".to_string())?;
        ensure_jar_loaded(&mut jars, &key)?;
        let values = jars.cookies.entry(key.clone()).or_default();
        for mutation in mutations {
            match mutation {
                CookieMutation::Remove(name) => values.retain(|cookie| cookie.name != name),
                CookieMutation::Upsert(cookie) => {
                    values.retain(|stored| stored.name != cookie.name);
                    values.push(cookie);
                }
            }
        }
        values.retain(|cookie| !cookie_is_expired(cookie, now));
        if values.len() > MAX_COOKIE_COUNT {
            return Err("Native session cookie limit exceeded".to_string());
        }
        // Mutate memory before persistence. If a response is lost after the
        // server commits, the exact device-code poll/confirm can be retried in
        // this process without ever exposing the provisional cookie to JS.
        if self.ephemeral_demo {
            Ok(())
        } else {
            persist_jar(&key, values)
        }
    }

    fn clear_active_session(&self) -> Result<(), String> {
        let base = self.active_base()?;
        let key = normalized_base(&base);
        let mut jars = self
            .jars
            .lock()
            .map_err(|_| "Native session cookie state is unavailable".to_string())?;
        ensure_jar_loaded(&mut jars, &key)?;
        let values = jars.cookies.entry(key.clone()).or_default();
        values.retain(|cookie| cookie.name == TRUST_COOKIE);
        if self.ephemeral_demo {
            Ok(())
        } else {
            persist_jar(&key, values)
        }
    }

    fn clear_all_sessions(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        let mut jars = match self.jars.lock() {
            Ok(jars) => jars,
            Err(poisoned) => {
                // A poisoned mutex must not leave live process cookies behind
                // during a shared-device sign-out. Recover only to erase it.
                failures.push("Native session cookie state was unavailable".to_string());
                poisoned.into_inner()
            }
        };
        let mut accounts = jars
            .cookies
            .keys()
            .map(|origin| session_account(origin))
            .collect::<HashSet<_>>();
        // Clear process memory before touching the credential manager. Even a
        // corrupt index or an unavailable keychain must immediately sign this
        // running desktop process out.
        jars.cookies.clear();
        jars.loaded.clear();
        jars.block_persisted_loads = true;
        if self.ephemeral_demo {
            return Ok(());
        }
        if let Err(error) = rotate_session_generation() {
            failures.push(error);
        }
        match read_session_index() {
            Ok(indexed) => accounts.extend(indexed),
            Err(error) => failures.push(error),
        }
        for account in accounts {
            if let Err(error) = delete_session_account(&account) {
                failures.push(error);
            }
        }
        if let Err(error) = delete_session_account(SESSION_INDEX_ACCOUNT) {
            failures.push(error);
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err("Could not clear every native session credential".to_string())
        }
    }
}

enum CookieMutation {
    Remove(String),
    Upsert(StoredSessionCookie),
}

#[tauri::command]
pub fn session_broker_initialize(
    window: WebviewWindow,
    state: State<'_, SessionBrokerState>,
    base_url: String,
) -> Result<SessionBrokerStatus, String> {
    ensure_main_bundled_window(&window, "Session broker")?;
    let base = validate_base_url(&base_url)?;
    state.activate(base.clone())?;
    Ok(SessionBrokerStatus {
        base_url: normalized_base(&base),
    })
}

/// Drop only the active login credential. Device-trust remains a separate,
/// user-approved credential just as it does after a normal browser logout.
#[tauri::command]
pub fn session_broker_clear(
    window: WebviewWindow,
    state: State<'_, SessionBrokerState>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Session broker")?;
    state.clear_active_session()
}

/// Shared-device sign-out: remove every origin-partitioned session record,
/// including servers that are not currently active. No cookie value is read
/// or returned to the renderer.
#[tauri::command]
pub fn session_broker_clear_all(
    window: WebviewWindow,
    state: State<'_, SessionBrokerState>,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Session broker")?;
    state.clear_all_sessions()
}

#[tauri::command]
pub fn session_broker_cancel(
    window: WebviewWindow,
    state: State<'_, SessionBrokerState>,
    request_id: String,
) -> Result<(), String> {
    ensure_main_bundled_window(&window, "Session broker")?;
    validate_request_id(&request_id)?;
    if let Some(sender) = state
        .cancellations
        .lock()
        .map_err(|_| "Session cancellation state is unavailable".to_string())?
        .remove(&request_id)
    {
        let _ = sender.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn session_broker_stream_request(
    window: WebviewWindow,
    state: State<'_, SessionBrokerState>,
    request: BrokerRequest,
    on_event: Channel,
) -> Result<BrokerResponseHead, String> {
    ensure_main_bundled_window(&window, "Session broker")?;
    validate_request_id(&request.request_id)?;
    let base = state.active_base()?;
    let request_id = request.request_id.clone();
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel();
    {
        let mut pending = state
            .cancellations
            .lock()
            .map_err(|_| "Session cancellation state is unavailable".to_string())?;
        if pending.contains_key(&request_id) {
            return Err("Session request id is already active".to_string());
        }
        pending.insert(request_id.clone(), cancel_tx);
    }
    // Register cancellation before loading the native jar. Credential stores
    // can briefly block; an already-aborted renderer request must not begin a
    // network exchange once that load completes.
    let (builder, request_url) = match build_session_request(&state, &base, request) {
        Ok(built) => built,
        Err(error) => {
            remove_cancellation(&state.cancellations, &request_id);
            return Err(error);
        }
    };
    let response = tokio::select! {
        response = builder.send() => response
            .map_err(|error| format!("Native session request failed: {error}")),
        _ = &mut cancel_rx => Err("Native session request cancelled".to_string()),
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
        return Err("Session response is too large".to_string());
    }
    // Process every Set-Cookie value natively before exposing the response
    // head. `response_headers` deliberately excludes Set-Cookie.
    if let Err(error) = state.capture_response_cookies(&base, &request_url, response.headers()) {
        remove_cancellation(&state.cancellations, &request_id);
        return Err(error);
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

fn build_session_request(
    state: &SessionBrokerState,
    base: &Url,
    request: BrokerRequest,
) -> Result<(reqwest::RequestBuilder, Url), String> {
    if request.body.len() > MAX_REQUEST_BYTES {
        return Err("Session request body is too large".to_string());
    }
    let url = validate_request_url(base.as_str(), &request.url)?;
    let method = validate_method(&request.method)?;
    let mut headers = validate_headers(request.headers)?;
    headers.insert(
        HeaderName::from_static("x-postwave-client"),
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        HeaderName::from_static("x-postwave-version"),
        HeaderValue::from_static(env!("CARGO_PKG_VERSION")),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static(native_user_agent()));
    if let Some(cookie) = state.cookie_header(base, &url)? {
        headers.insert(COOKIE, cookie);
    }
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    let mut builder = state
        .client
        .request(method, url.clone())
        .headers(headers)
        .timeout(Duration::from_millis(timeout_ms));
    if !request.body.is_empty() {
        builder = builder.body(request.body);
    }
    Ok((builder, url))
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
                .map_err(|error| format!("Native session response failed: {error}"))?,
            _ = &mut *cancel_rx => return Err("Native session request cancelled".to_string()),
        };
        let Some(chunk) = chunk else { return Ok(()) };
        received = received.saturating_add(chunk.len());
        if received > MAX_RESPONSE_BYTES {
            return Err("Session response is too large".to_string());
        }
        on_event
            .send(InvokeResponseBody::Raw(chunk.to_vec()))
            .map_err(|error| format!("Could not stream native session response: {error}"))?;
    }
}

fn parse_cookie_mutation(
    base: &Url,
    response_url: &Url,
    raw: &str,
    now: i64,
) -> Result<Option<CookieMutation>, String> {
    if raw.len() > MAX_COOKIE_VALUE_BYTES.saturating_add(1024) {
        let oversized_name = raw
            .split_once('=')
            .map(|(name, _)| name.trim())
            .unwrap_or_default();
        if is_allowed_cookie_name(oversized_name) {
            return Err("Server returned an oversized session cookie".to_string());
        }
        return Ok(None);
    }
    let parsed = match Cookie::parse(raw.to_string()) {
        Ok(cookie) => cookie,
        Err(_) => return Ok(None),
    };
    let name = parsed.name();
    if !is_allowed_cookie_name(name) {
        return Ok(None);
    }
    if !valid_cookie_value(parsed.value()) {
        // Empty values are accepted only as an expiry mutation below.
        if !cookie_is_deletion(&parsed, now) {
            return Err("Server returned an invalid session cookie".to_string());
        }
    }
    if parsed.http_only() != Some(true) {
        return Err("Server session cookie is missing HttpOnly".to_string());
    }
    if base.scheme() == "https" && parsed.secure() != Some(true) {
        return Err("Server session cookie is missing Secure".to_string());
    }
    if let Some(domain) = parsed.domain() {
        let host = response_url
            .host_str()
            .ok_or_else(|| "Session response has no host".to_string())?;
        if !cookie_domain_matches(host, domain) {
            return Err("Server session cookie has an invalid domain".to_string());
        }
    }
    let expected_path = expected_cookie_path(name);
    let path = parsed.path().unwrap_or(expected_path);
    if path != expected_path {
        return Err("Server session cookie has an invalid path".to_string());
    }
    if cookie_is_deletion(&parsed, now) {
        return Ok(Some(CookieMutation::Remove(name.to_string())));
    }
    let expires_at = cookie_expiry(&parsed, now);
    Ok(Some(CookieMutation::Upsert(StoredSessionCookie {
        name: name.to_string(),
        value: parsed.value().to_string(),
        path: path.to_string(),
        secure: parsed.secure().unwrap_or(false),
        expires_at,
    })))
}

fn cookie_is_deletion(cookie: &Cookie<'_>, now: i64) -> bool {
    if cookie
        .max_age()
        .is_some_and(|duration| duration.whole_seconds() <= 0)
    {
        return true;
    }
    cookie
        .expires_datetime()
        .is_some_and(|expires| expires.unix_timestamp() <= now)
}

fn cookie_expiry(cookie: &Cookie<'_>, now: i64) -> Option<i64> {
    if let Some(max_age) = cookie.max_age() {
        let seconds = max_age
            .whole_seconds()
            .clamp(1, MAX_COOKIE_LIFETIME_SECONDS);
        return Some(now.saturating_add(seconds));
    }
    cookie.expires_datetime().map(|expires| {
        expires
            .unix_timestamp()
            .min(now.saturating_add(MAX_COOKIE_LIFETIME_SECONDS))
    })
}

fn is_allowed_cookie_name(name: &str) -> bool {
    matches!(
        name,
        SESSION_COOKIE | TRUST_COOKIE | WEBAUTHN_REGISTER_COOKIE | WEBAUTHN_LOGIN_COOKIE
    )
}

fn expected_cookie_path(name: &str) -> &'static str {
    match name {
        WEBAUTHN_REGISTER_COOKIE | WEBAUTHN_LOGIN_COOKIE => "/api/v1/auth/webauthn",
        _ => "/",
    }
}

fn cookie_domain_matches(host: &str, domain: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let domain = domain
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == domain || host.ends_with(&format!(".{domain}"))
}

fn cookie_path_matches(request_path: &str, cookie_path: &str) -> bool {
    if request_path == cookie_path {
        return true;
    }
    request_path.starts_with(cookie_path)
        && (cookie_path.ends_with('/')
            || request_path
                .as_bytes()
                .get(cookie_path.len())
                .is_some_and(|value| *value == b'/'))
}

fn cookie_is_expired(cookie: &StoredSessionCookie, now: i64) -> bool {
    cookie.expires_at.is_some_and(|expires| expires <= now)
}

/// RFC 6265 cookie-octet. Keeping the stored value inside this vocabulary
/// prevents a corrupt credential record from smuggling a second Cookie pair.
fn valid_cookie_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_COOKIE_VALUE_BYTES
        && value.bytes().all(|byte| {
            matches!(
                byte,
                0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e
            )
        })
}

fn should_persist_cookie(cookie: &StoredSessionCookie) -> bool {
    cookie.expires_at.is_some() && matches!(cookie.name.as_str(), SESSION_COOKIE | TRUST_COOKIE)
}

fn ensure_jar_loaded(jars: &mut SessionJars, base: &str) -> Result<(), String> {
    if jars.loaded.contains(base) {
        return Ok(());
    }
    let cookies = if jars.block_persisted_loads {
        Vec::new()
    } else {
        read_persisted_jar(base)?
    };
    jars.cookies.insert(base.to_string(), cookies);
    jars.loaded.insert(base.to_string());
    Ok(())
}

fn purge_expired_and_persist(jars: &mut SessionJars, base: &str) -> Result<(), String> {
    let now = unix_now();
    let values = jars.cookies.entry(base.to_string()).or_default();
    let before = values.len();
    values.retain(|cookie| !cookie_is_expired(cookie, now));
    if values.len() != before {
        persist_jar(base, values)?;
    }
    Ok(())
}

fn persist_jar(base: &str, cookies: &[StoredSessionCookie]) -> Result<(), String> {
    let persistent = cookies
        .iter()
        // WebAuthn challenges are intentionally process-only even though the
        // server gives them a short Max-Age. A restarted ceremony can safely
        // begin again, and keeping them out of the OS store leaves ample room
        // under Windows Credential Manager's small record ceiling.
        .filter(|cookie| should_persist_cookie(cookie))
        .cloned()
        .collect::<Vec<_>>();
    let account = session_account(base);
    if persistent.is_empty() {
        delete_session_account(&account)?;
        return update_session_index(base, false);
    }
    let record = PersistedSessionRecord {
        version: SESSION_RECORD_VERSION,
        base_binding: account.clone(),
        generation: read_session_generation()?,
        cookies: persistent,
    };
    let encoded = Zeroizing::new(
        serde_json::to_vec(&record)
            .map_err(|_| "Could not encode native session state".to_string())?,
    );
    if encoded.len() > MAX_COOKIE_RECORD_BYTES {
        return Err("Native session record is too large".to_string());
    }
    // Index first. If the subsequent credential write fails, clear-all has a
    // harmless extra origin to inspect; the reverse order could orphan a live
    // session record from shared-device sign-out.
    update_session_index(base, true)?;
    session_entry(&account)?
        .set_secret(encoded.as_slice())
        .map_err(|error| error.to_string())
}

fn read_session_index() -> Result<HashSet<String>, String> {
    let encoded = match session_entry(SESSION_INDEX_ACCOUNT)?.get_secret() {
        Ok(encoded) => encoded,
        Err(keyring::Error::NoEntry) => return Ok(HashSet::new()),
        Err(error) => return Err(error.to_string()),
    };
    if encoded.len() > MAX_COOKIE_RECORD_BYTES {
        return Err("Native session index is invalid".to_string());
    }
    let values: Vec<String> = serde_json::from_slice(&encoded)
        .map_err(|_| "Native session index is invalid".to_string())?;
    if values.len() > MAX_SESSION_ORIGINS {
        return Err("Native session index is invalid".to_string());
    }
    let mut accounts = HashSet::new();
    for value in values {
        if value.len() != SESSION_ACCOUNT_PREFIX.len() + 64
            || !value.starts_with(SESSION_ACCOUNT_PREFIX)
            || !value[SESSION_ACCOUNT_PREFIX.len()..]
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
        {
            return Err("Native session index is invalid".to_string());
        }
        accounts.insert(value);
    }
    Ok(accounts)
}

fn update_session_index(base: &str, present: bool) -> Result<(), String> {
    let mut accounts = read_session_index()?;
    let account = session_account(base);
    if present {
        accounts.insert(account);
        if accounts.len() > MAX_SESSION_ORIGINS {
            return Err("Native session origin limit exceeded".to_string());
        }
    } else {
        accounts.remove(&account);
    }
    if accounts.is_empty() {
        return delete_session_account(SESSION_INDEX_ACCOUNT);
    }
    let mut values = accounts.into_iter().collect::<Vec<_>>();
    values.sort();
    let encoded = serde_json::to_vec(&values)
        .map_err(|_| "Could not encode native session index".to_string())?;
    if encoded.len() > MAX_COOKIE_RECORD_BYTES {
        return Err("Native session index is too large".to_string());
    }
    session_entry(SESSION_INDEX_ACCOUNT)?
        .set_secret(&encoded)
        .map_err(|error| error.to_string())
}

fn read_persisted_jar(base: &str) -> Result<Vec<StoredSessionCookie>, String> {
    let account = session_account(base);
    let encoded = match session_entry(&account)?.get_secret() {
        Ok(encoded) => encoded,
        Err(keyring::Error::NoEntry) => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let encoded = Zeroizing::new(encoded);
    if encoded.len() > MAX_COOKIE_RECORD_BYTES {
        delete_session_account(&account)?;
        return Ok(Vec::new());
    }
    let record: PersistedSessionRecord = match serde_json::from_slice(encoded.as_slice()) {
        Ok(record) => record,
        Err(_) => {
            delete_session_account(&account)?;
            return Ok(Vec::new());
        }
    };
    let current_generation = read_session_generation()?;
    if record.version != SESSION_RECORD_VERSION
        || record.base_binding != account
        || record.generation != current_generation
        || record.cookies.len() > MAX_COOKIE_COUNT
    {
        delete_session_account(&account)?;
        return Ok(Vec::new());
    }
    let now = unix_now();
    let mut valid = Vec::new();
    for cookie in record.cookies {
        if !validate_persisted_cookie(&cookie, now) {
            delete_session_account(&account)?;
            return Ok(Vec::new());
        }
        if !cookie_is_expired(&cookie, now) {
            valid.push(cookie);
        }
    }
    if valid.is_empty() {
        delete_session_account(&account)?;
    }
    Ok(valid)
}

fn validate_persisted_cookie(cookie: &StoredSessionCookie, now: i64) -> bool {
    is_allowed_cookie_name(&cookie.name)
        && cookie.path == expected_cookie_path(&cookie.name)
        && valid_cookie_value(&cookie.value)
        && cookie
            .expires_at
            .is_some_and(|expires| expires > now && expires <= now + MAX_COOKIE_LIFETIME_SECONDS)
}

fn session_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, account).map_err(|error| error.to_string())
}

fn read_session_generation() -> Result<String, String> {
    let encoded = match session_entry(SESSION_GENERATION_ACCOUNT)?.get_secret() {
        Ok(encoded) => encoded,
        Err(keyring::Error::NoEntry) => return Ok(INITIAL_SESSION_GENERATION.to_string()),
        Err(error) => return Err(error.to_string()),
    };
    if encoded.len() != 32
        || !encoded
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Native session generation is invalid".to_string());
    }
    String::from_utf8(encoded).map_err(|_| "Native session generation is invalid".to_string())
}

fn rotate_session_generation() -> Result<(), String> {
    let mut entropy = [0u8; 16];
    getrandom::fill(&mut entropy)
        .map_err(|_| "Could not rotate native session generation".to_string())?;
    let generation = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    entropy.zeroize();
    session_entry(SESSION_GENERATION_ACCOUNT)?
        .set_secret(generation.as_bytes())
        .map_err(|error| error.to_string())
}

fn delete_session_account(account: &str) -> Result<(), String> {
    match session_entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn session_account(base: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"postwave-desktop-session-origin-v1\0");
    digest.update(base.as_bytes());
    format!("{SESSION_ACCOUNT_PREFIX}{:x}", digest.finalize())
}

fn normalized_base(base: &Url) -> String {
    base.as_str().trim_end_matches('/').to_string()
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

#[cfg(target_os = "windows")]
const NATIVE_USER_AGENT: &str =
    concat!("Moosewave Desktop/", env!("CARGO_PKG_VERSION"), " (Windows)");
#[cfg(target_os = "macos")]
const NATIVE_USER_AGENT: &str = concat!(
    "Moosewave Desktop/",
    env!("CARGO_PKG_VERSION"),
    " (Macintosh; Mac OS X)"
);
#[cfg(target_os = "linux")]
const NATIVE_USER_AGENT: &str = concat!(
    "Moosewave Desktop/",
    env!("CARGO_PKG_VERSION"),
    " (X11; Linux)"
);

pub(crate) const fn native_user_agent() -> &'static str {
    NATIVE_USER_AGENT
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
        Err("invalid session request id".to_string())
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

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderMap;
    use std::collections::BTreeMap;

    fn base() -> Url {
        validate_base_url("https://api.moosewave.com").unwrap()
    }

    #[test]
    fn platform_keyring_is_durable_not_process_mocked() {
        assert!(matches!(
            keyring::default::default_credential_builder().persistence(),
            keyring::credential::CredentialPersistence::UntilDelete
        ));
    }

    // The three properties below were each named by an existing test and
    // exercised by none of them. Verified by mutation: deleting the HttpOnly
    // requirement, deleting the name allowlist's CALL SITE, and weakening the
    // domain matcher all left the suite at 10/10 green.
    #[test]
    fn cookie_without_httponly_is_refused() {
        // The sibling test covers "missing Secure" and has no case for missing
        // HttpOnly, so the whole check could be deleted silently. HttpOnly is
        // what keeps a renderer compromise from reading the session cookie.
        let origin = base();
        let response = Url::parse("https://api.moosewave.com/api/v1/auth/login").unwrap();
        let now = 1_800_000_000;
        assert!(
            parse_cookie_mutation(
                &origin,
                &response,
                "pw_session=id.verifier; Path=/; Max-Age=3600; Secure",
                now
            )
            .is_err(),
            "a session cookie without HttpOnly was accepted"
        );
        // Guard the guard: the same cookie WITH HttpOnly must still be accepted.
        assert!(matches!(
            parse_cookie_mutation(
                &origin,
                &response,
                "pw_session=id.verifier; Path=/; Max-Age=3600; Secure; HttpOnly",
                now
            )
            .unwrap(),
            Some(CookieMutation::Upsert(_))
        ));
    }

    #[test]
    fn unknown_cookie_names_are_ignored_by_the_parser_itself() {
        // accepts_only_the_native_auth_cookie_vocabulary tests
        // is_allowed_cookie_name() directly, so removing the CALL SITE in
        // parse_cookie_mutation left it green. The function was guarded; its
        // use was not.
        let origin = base();
        let response = Url::parse("https://api.moosewave.com/api/v1/auth/login").unwrap();
        let now = 1_800_000_000;
        for raw in [
            "attacker_cookie=x; Path=/; Secure; HttpOnly",
            "pw_session_backup=x; Path=/; Secure; HttpOnly",
            "session=x; Path=/; Secure; HttpOnly",
        ] {
            assert!(
                parse_cookie_mutation(&origin, &response, raw, now)
                    .unwrap()
                    .is_none(),
                "parser stored a cookie outside the allowlist: {raw}"
            );
        }
    }

    #[test]
    fn domain_match_requires_a_label_boundary() {
        // `host.ends_with(domain)` without the leading dot lets
        // "evilmoosewave.com" match "moosewave.com". The existing domain case
        // uses "evil.example", which fails under BOTH the correct and the
        // vulnerable matcher, so it cannot detect the difference.
        //
        // Today the jar is per-base and redirects are disabled
        // (Policy::none()), so the exploit path is narrow. The rule is pinned
        // because it stops being narrow the moment either of those changes.
        assert!(cookie_domain_matches("api.moosewave.com", "moosewave.com"));
        assert!(cookie_domain_matches("moosewave.com", "moosewave.com"));
        assert!(
            !cookie_domain_matches("evilmoosewave.com", "moosewave.com"),
            "a non-boundary suffix matched; the leading-dot rule is gone"
        );
        assert!(!cookie_domain_matches(
            "moosewave.com.evil.example",
            "moosewave.com"
        ));
        // Trailing dots and case must not defeat it either.
        assert!(cookie_domain_matches("API.Moosewave.com.", ".moosewave.com"));
    }

    #[test]
    fn accepts_only_the_native_auth_cookie_vocabulary() {
        for name in [
            SESSION_COOKIE,
            TRUST_COOKIE,
            WEBAUTHN_REGISTER_COOKIE,
            WEBAUTHN_LOGIN_COOKIE,
        ] {
            assert!(is_allowed_cookie_name(name));
        }
        assert!(!is_allowed_cookie_name("attacker_cookie"));
        assert!(!is_allowed_cookie_name("pw_session_backup"));
    }

    #[test]
    fn cookie_parser_enforces_security_domain_and_path() {
        let origin = base();
        let response = Url::parse("https://api.moosewave.com/api/v1/auth/login").unwrap();
        let now = 1_800_000_000;
        assert!(matches!(
            parse_cookie_mutation(
                &origin,
                &response,
                "pw_session=id.verifier; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax",
                now
            )
            .unwrap(),
            Some(CookieMutation::Upsert(_))
        ));
        assert!(parse_cookie_mutation(
            &origin,
            &response,
            "pw_session=id.verifier; Path=/; Max-Age=3600; HttpOnly",
            now
        )
        .is_err());
        assert!(parse_cookie_mutation(
            &origin,
            &response,
            "pw_session=id.verifier; Domain=evil.example; Path=/; Secure; HttpOnly",
            now
        )
        .is_err());
        assert!(parse_cookie_mutation(
            &origin,
            &response,
            "pw_session=id.verifier; Path=/admin; Secure; HttpOnly",
            now
        )
        .is_err());
        let oversized = format!(
            "pw_session={}; Path=/; Secure; HttpOnly",
            "a".repeat(MAX_COOKIE_VALUE_BYTES + 1024)
        );
        assert!(parse_cookie_mutation(&origin, &response, &oversized, now).is_err());
    }

    #[test]
    fn deletion_and_session_lifetime_are_distinct() {
        let origin = base();
        let response = Url::parse("https://api.moosewave.com/api/v1/auth/logout").unwrap();
        let now = 1_800_000_000;
        let session_only = parse_cookie_mutation(
            &origin,
            &response,
            "pw_session=id.verifier; Path=/; Secure; HttpOnly",
            now,
        )
        .unwrap();
        match session_only {
            Some(CookieMutation::Upsert(cookie)) => assert!(cookie.expires_at.is_none()),
            _ => panic!("expected an in-memory session cookie"),
        }
        assert!(matches!(
            parse_cookie_mutation(
                &origin,
                &response,
                "pw_session=; Path=/; Max-Age=-1; Secure; HttpOnly",
                now
            )
            .unwrap(),
            Some(CookieMutation::Remove(name)) if name == SESSION_COOKIE
        ));
    }

    #[test]
    fn persisted_values_cannot_smuggle_cookie_pairs_or_auth_ceremonies() {
        assert!(valid_cookie_value("opaque-id.opaque_verifier-123"));
        assert!(!valid_cookie_value("first; pw_session=second"));
        assert!(!valid_cookie_value("quoted\"value"));
        assert!(!valid_cookie_value("contains space"));

        let persistent = |name: &str| StoredSessionCookie {
            name: name.to_string(),
            value: "opaque.value".to_string(),
            path: expected_cookie_path(name).to_string(),
            secure: true,
            expires_at: Some(1_900_000_000),
        };
        assert!(should_persist_cookie(&persistent(SESSION_COOKIE)));
        assert!(should_persist_cookie(&persistent(TRUST_COOKIE)));
        assert!(!should_persist_cookie(&persistent(WEBAUTHN_LOGIN_COOKIE)));
        assert!(!should_persist_cookie(&persistent(
            WEBAUTHN_REGISTER_COOKIE
        )));
    }

    #[test]
    fn cookie_header_is_path_scoped_and_never_a_response_header() {
        assert!(cookie_path_matches("/api/v1/auth/me", "/"));
        assert!(cookie_path_matches(
            "/api/v1/auth/webauthn/login/finish",
            "/api/v1/auth/webauthn"
        ));
        assert!(!cookie_path_matches(
            "/api/v1/auth/webauthn-attacker",
            "/api/v1/auth/webauthn"
        ));
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("pw_session=top-secret; Secure; HttpOnly"),
        );
        let exposed = response_headers(&headers);
        assert!(!exposed.contains_key("set-cookie"));
        assert!(!format!("{exposed:?}").contains("top-secret"));
    }

    #[test]
    fn persistence_account_is_origin_partitioned_without_embedding_the_url() {
        let first = session_account("https://api-a.example");
        let second = session_account("https://api-b.example");
        assert_ne!(first, second);
        assert!(!first.contains("api-a.example"));
        assert!(first.starts_with(SESSION_ACCOUNT_PREFIX));

        let full_index = (0..MAX_SESSION_ORIGINS)
            .map(|index| session_account(&format!("https://api-{index}.example")))
            .collect::<Vec<_>>();
        assert!(serde_json::to_vec(&full_index).unwrap().len() <= MAX_COOKIE_RECORD_BYTES);
    }

    #[test]
    fn shared_device_wipe_blocks_stale_keychain_reloads_in_process() {
        let mut jars = SessionJars {
            block_persisted_loads: true,
            ..SessionJars::default()
        };
        let origin = "https://api.moosewave.com";
        ensure_jar_loaded(&mut jars, origin).unwrap();
        assert!(jars.loaded.contains(origin));
        assert!(jars.cookies.get(origin).is_some_and(Vec::is_empty));
    }

    #[test]
    fn renderer_request_validation_still_blocks_origin_and_cookie_smuggling() {
        let state = SessionBrokerState::new();
        for name in [
            "authorization",
            "cookie",
            "origin",
            "user-agent",
            "x-postwave-client",
        ] {
            let request = BrokerRequest {
                request_id: "test-request".to_string(),
                url: "https://api.moosewave.com/api/v1/auth/me".to_string(),
                method: "GET".to_string(),
                headers: BTreeMap::from([(name.to_string(), "attacker".to_string())]),
                body: Vec::new(),
                timeout_ms: Some(1000),
            };
            assert!(
                build_session_request(&state, &base(), request).is_err(),
                "accepted {name}"
            );
        }
        let other_origin = BrokerRequest {
            request_id: "test-request".to_string(),
            url: "https://evil.example/api/v1/auth/me".to_string(),
            method: "GET".to_string(),
            headers: BTreeMap::new(),
            body: Vec::new(),
            timeout_ms: Some(1000),
        };
        assert!(build_session_request(&state, &base(), other_origin).is_err());
    }

    #[test]
    fn provisional_poll_cookie_round_trips_on_the_exact_confirm_request() {
        let state = SessionBrokerState::new();
        let origin = base();
        let key = normalized_base(&origin);
        {
            let mut jars = state.jars.lock().unwrap();
            jars.loaded.insert(key.clone());
            jars.cookies.insert(
                key,
                vec![StoredSessionCookie {
                    name: SESSION_COOKIE.to_string(),
                    value: "provisional.id".to_string(),
                    path: "/".to_string(),
                    secure: true,
                    expires_at: None,
                }],
            );
        }
        let confirm_body = br#"{"device_code":"same-code","action":"confirm"}"#.to_vec();
        let request = BrokerRequest {
            request_id: "confirm-request".to_string(),
            url: "https://api.moosewave.com/api/v1/auth/cli/device/token".to_string(),
            method: "POST".to_string(),
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: confirm_body.clone(),
            timeout_ms: Some(1_000),
        };
        let (builder, _) = build_session_request(&state, &origin, request).unwrap();
        let request = builder.build().unwrap();
        assert_eq!(
            request
                .headers()
                .get(COOKIE)
                .and_then(|value| value.to_str().ok()),
            Some("pw_session=provisional.id")
        );
        assert_eq!(
            request.body().and_then(reqwest::Body::as_bytes),
            Some(confirm_body.as_slice())
        );
    }
}
