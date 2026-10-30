//! Native security boundary for `moosewave://` deep links.
//!
//! Every OS entry point (cold start, an already-running app, and a second
//! process launch) passes through this module before the renderer sees a URL.
//! Inputs are byte-capped, parsed with an explicit action/parameter grammar,
//! percent-decoded exactly once, validated, and rebuilt into a canonical URL.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

const DEEP_LINK_EVENT: &str = "deep-link://opened";
const MAX_DEEP_LINK_BYTES: usize = 8 * 1024;
const MAX_PENDING_LINKS: usize = 16;
const MAX_RESOURCE_ID_BYTES: usize = 128;
const MAX_SUBSCRIBER_BYTES: usize = 254;
const MAX_AUTH_TOKEN_BYTES: usize = 2_048;
const MAX_STATE_BYTES: usize = 256;
const MIN_AUTH_STATE_BYTES: usize = 16;
const MAX_AUTH_STATE_BYTES: usize = 128;
const AUTH_LINK_VERSION: &str = "1";
const AUTH_LINK_NATIVE_AUDIENCE: &str = "mobile";
const AUTH_LINK_SIGNATURE_BYTES: usize = 43;

const MIGRATION_SOURCES: &[&str] = &[
    "mailchimp",
    "klaviyo",
    "customerio",
    "constant-contact",
    "aweber",
    "drip",
    "campaign-monitor",
    "omnisend",
    "loops",
    "flodesk",
    "bento",
    "activecampaign",
    "substack",
    "beehiiv",
    "convertkit",
    "mailerlite",
    "brevo",
    "hubspot",
    "sendy",
    "csv",
    "other",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeepLinkPayload {
    pub action: String,
    pub resource_id: String,
    pub route: String,
    /// Canonical URL. This is the only URL emitted to the renderer.
    pub raw_url: String,
}

/// Renderer-facing messages contain either a canonical allowlisted URL or a
/// redacted auth-link rejection. Rejected input is never echoed across IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeepLinkDelivery {
    Opened {
        url: String,
    },
    Rejected {
        reason: AuthLinkRejectionReason,
        flow: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthLinkRejectionReason {
    InvalidLink,
    UnsupportedVersion,
    WrongDevice,
    WrongFlow,
    InvalidSignature,
}

#[derive(Default)]
struct DeliveryQueue {
    renderer_ready: bool,
    pending: VecDeque<DeepLinkDelivery>,
}

impl DeliveryQueue {
    /// Returns the URL when it should be emitted immediately.
    fn submit(&mut self, message: DeepLinkDelivery) -> Option<DeepLinkDelivery> {
        if self.renderer_ready {
            return Some(message);
        }
        if self.pending.back() == Some(&message) {
            return None;
        }
        if self.pending.len() == MAX_PENDING_LINKS {
            self.pending.pop_front();
        }
        self.pending.push_back(message);
        None
    }

    fn mark_ready_and_drain(&mut self) -> Vec<DeepLinkDelivery> {
        self.renderer_ready = true;
        self.pending.drain(..).collect()
    }
}

#[derive(Default)]
pub struct DeepLinkState {
    delivery: Mutex<DeliveryQueue>,
}

/// Entity deep-link actions this shell can route, paired with the `/app/<slug>`
/// collection they resolve to.
///
/// MUST mirror `packages/route-map/src/entities.ts` — specifically, every entry
/// whose `surfaces.desktop` is not `"none"`, keyed and slugged identically.
/// `scripts/check-route-map-destinations.mjs` compares the two and fails CI on
/// any divergence, because the two halves of a deep link are minted by the TS
/// registry and consumed by this parser: an action the registry emits but this
/// table omits is a link that silently does nothing when the user taps it.
///
/// `subscriber` is intentionally ABSENT: it is addressed by email rather than
/// by resource id and is handled by its own arm below, which routes to
/// `/app/subscribers?email=…`.
///
/// Deliberately excluded because desktop has no such section
/// (`desktop-router.ts SECTION_SLUGS`) and would fail `unknown-destination`:
/// `flow` (desktop's section is `automations`), `inbound-webhook` (desktop's
/// `webhooks` is the OUTBOUND catalog), `landing-page`, `sequence-template`.
const ENTITY_COLLECTIONS: &[(&str, &str)] = &[
    ("approval", "approvals"),
    ("campaign", "campaigns"),
    ("sequence", "sequences"),
    ("form", "forms"),
    ("list", "lists"),
    ("segment", "segments"),
    ("helpdesk-conversation", "helpdesk"),
    ("template", "templates"),
    ("migration", "migrations"),
    ("discount", "discounts"),
    ("integration", "integrations"),
    ("affiliate", "affiliates"),
    // Reachable from global search (internal/search/index.go collects a
    // "suppression" type) and routed by the desktop shell, so the deep link the
    // route-map mints has to resolve here too — otherwise
    // moosewave://suppression/<id> is rejected as an unknown action.
    ("suppression", "suppressions"),
];

/// The `/app` collection slug for an entity deep-link action, or `None` when
/// this shell does not route that action.
fn entity_collection(action: &str) -> Option<&'static str> {
    ENTITY_COLLECTIONS
        .iter()
        .find(|(key, _)| *key == action)
        .map(|(_, collection)| *collection)
}

/// Validate and canonicalize a `moosewave://` URL.
///
/// Parsing is deliberately strict. In particular, decoded `%` characters are
/// not accepted by any value grammar, so `%252f` cannot survive this boundary
/// and turn into `/` after a later decoder runs.
pub fn validate_postwave_url(raw: &str) -> Result<DeepLinkPayload, &'static str> {
    if raw.is_empty() || raw.len() > MAX_DEEP_LINK_BYTES {
        return Err("deep link length is outside the allowed range");
    }
    if !raw.is_ascii() || raw.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err("deep link contains non-ASCII or control characters");
    }
    if raw.contains('\\') || raw.contains('#') {
        return Err("deep link contains a forbidden separator or fragment");
    }

    let rest = raw
        .strip_prefix("moosewave://")
        .ok_or("deep link scheme is not postwave")?;
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let action = &rest[..authority_end];
    if action.is_empty()
        || !action
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
    {
        return Err("deep link action is malformed");
    }

    let remainder = &rest[authority_end..];
    let (raw_path, raw_query) = match remainder.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (remainder, None),
    };
    if !raw_path.is_empty() && !raw_path.starts_with('/') {
        return Err("deep link path is malformed");
    }
    let raw_segments: Vec<&str> = if raw_path.is_empty() {
        Vec::new()
    } else {
        raw_path[1..].split('/').collect()
    };
    if raw_segments.iter().any(|segment| segment.is_empty()) {
        return Err("deep link path contains an empty segment");
    }
    let segments: Vec<String> = raw_segments
        .iter()
        .map(|segment| decode_component_once(segment))
        .collect::<Result<_, _>>()?;

    match action {
        _ if entity_collection(action).is_some() => {
            require_no_query(raw_query)?;
            let id = exactly_one_segment(&segments)?;
            let id_is_allowed = if action == "helpdesk-conversation" {
                is_canonical_lowercase_uuid(id)
            } else {
                is_resource_id(id)
            };
            if !id_is_allowed {
                return Err("deep link resource id is not allowed");
            }
            let collection = entity_collection(action).expect("guarded by match arm");
            Ok(DeepLinkPayload {
                action: action.to_string(),
                resource_id: id.to_string(),
                route: format!("/app/{collection}/{id}"),
                raw_url: format!("moosewave://{action}/{id}"),
            })
        }
        "subscriber" => {
            require_no_query(raw_query)?;
            let subscriber = exactly_one_segment(&segments)?;
            if !is_subscriber_target(subscriber) {
                return Err("deep link subscriber target is not allowed");
            }
            Ok(DeepLinkPayload {
                action: action.to_string(),
                resource_id: subscriber.to_string(),
                route: format!("/app/subscribers?email={subscriber}"),
                raw_url: format!("moosewave://subscriber/{subscriber}"),
            })
        }
        "settings" => {
            if !segments.is_empty() || raw_query.is_some() {
                return Err("settings deep link does not accept a path or query");
            }
            Ok(DeepLinkPayload {
                action: action.to_string(),
                resource_id: String::new(),
                route: "/app/settings".to_string(),
                raw_url: "moosewave://settings".to_string(),
            })
        }
        "auth" => validate_auth_link(&segments, raw_query),
        "migrations" => validate_migrations_link(&segments, raw_query),
        "migrate" => validate_legacy_migration_link(&segments, raw_query),
        _ => Err("deep link action is not allowlisted"),
    }
}

fn validate_auth_link(
    segments: &[String],
    raw_query: Option<&str>,
) -> Result<DeepLinkPayload, &'static str> {
    let auth_action = exactly_one_segment(segments)?;
    let expected_flow = match auth_action {
        "magic" | "magic-link" => "magic",
        "reset" | "reset-password" => "reset",
        _ => {
            return Err("auth deep link action is not allowlisted");
        }
    };
    // These six fields are the complete backend HMAC envelope. Dropping even
    // one changes the signed message and makes packaged magic, reset, and
    // OAuth-return flows impossible to consume.
    let params = parse_query(raw_query, &["token", "v", "flow", "aud", "state", "sig"])?;
    let token = required_base64url(&params, "token", 1, MAX_AUTH_TOKEN_BYTES)?;
    let version = required_opaque(&params, "v", 4)?;
    if version != AUTH_LINK_VERSION {
        return Err("auth link version is unsupported");
    }
    let flow = required_opaque(&params, "flow", 16)?;
    if flow != expected_flow {
        return Err("auth link flow does not match its path");
    }
    let audience = required_opaque(&params, "aud", 16)?;
    if audience != AUTH_LINK_NATIVE_AUDIENCE {
        return Err("auth link audience is not native");
    }
    let state = required_base64url(&params, "state", MIN_AUTH_STATE_BYTES, MAX_AUTH_STATE_BYTES)?;
    let signature = required_base64url(
        &params,
        "sig",
        AUTH_LINK_SIGNATURE_BYTES,
        AUTH_LINK_SIGNATURE_BYTES,
    )
    .map_err(|_| "auth link signature is malformed")?;

    let mut canonical = format!("moosewave://auth/{expected_flow}");
    let mut separator = '?';
    append_query_pair(&mut canonical, &mut separator, "token", token);
    append_query_pair(&mut canonical, &mut separator, "v", version);
    append_query_pair(&mut canonical, &mut separator, "flow", flow);
    append_query_pair(&mut canonical, &mut separator, "aud", audience);
    append_query_pair(&mut canonical, &mut separator, "state", state);
    append_query_pair(&mut canonical, &mut separator, "sig", signature);

    Ok(DeepLinkPayload {
        action: "auth".to_string(),
        resource_id: expected_flow.to_string(),
        route: format!("/auth/{expected_flow}"),
        raw_url: canonical,
    })
}

fn validate_migrations_link(
    segments: &[String],
    raw_query: Option<&str>,
) -> Result<DeepLinkPayload, &'static str> {
    if exactly_one_segment(segments)? != "api-key" {
        return Err("migration deep link path is not allowlisted");
    }
    let params = parse_query(raw_query, &["source", "state"])?;
    let source = match params.get("source") {
        Some(source) if MIGRATION_SOURCES.contains(&source.as_str()) => Some(source.as_str()),
        Some(_) => return Err("migration source is not allowlisted"),
        None => None,
    };
    let state = optional_opaque(&params, "state", MAX_STATE_BYTES)?;

    let mut canonical = "moosewave://migrations/api-key".to_string();
    let mut route = "/app/migrations/api-key".to_string();
    let mut canonical_separator = '?';
    let mut route_separator = '?';
    if let Some(source) = source {
        append_query_pair(&mut canonical, &mut canonical_separator, "source", source);
        append_query_pair(&mut route, &mut route_separator, "source", source);
    }
    if let Some(state) = state {
        append_query_pair(&mut canonical, &mut canonical_separator, "state", state);
        append_query_pair(&mut route, &mut route_separator, "state", state);
    }

    Ok(DeepLinkPayload {
        action: "migrations".to_string(),
        resource_id: "api-key".to_string(),
        route,
        raw_url: canonical,
    })
}

fn validate_legacy_migration_link(
    segments: &[String],
    raw_query: Option<&str>,
) -> Result<DeepLinkPayload, &'static str> {
    if segments.len() != 2 || segments[1] != "api-key-entry" {
        return Err("legacy migration deep link path is not allowlisted");
    }
    let source = segments[0].as_str();
    if !MIGRATION_SOURCES.contains(&source) {
        return Err("migration source is not allowlisted");
    }
    let params = parse_query(raw_query, &["state"])?;
    let state = optional_opaque(&params, "state", MAX_STATE_BYTES)?;

    // Normalize the legacy shape to the one renderer route contract.
    let mut canonical = "moosewave://migrations/api-key".to_string();
    let mut route = "/app/migrations/api-key".to_string();
    let mut canonical_separator = '?';
    let mut route_separator = '?';
    append_query_pair(&mut canonical, &mut canonical_separator, "source", source);
    append_query_pair(&mut route, &mut route_separator, "source", source);
    if let Some(state) = state {
        append_query_pair(&mut canonical, &mut canonical_separator, "state", state);
        append_query_pair(&mut route, &mut route_separator, "state", state);
    }

    Ok(DeepLinkPayload {
        action: "migrations".to_string(),
        resource_id: "api-key".to_string(),
        route,
        raw_url: canonical,
    })
}

fn exactly_one_segment(segments: &[String]) -> Result<&str, &'static str> {
    if segments.len() != 1 {
        return Err("deep link has an unexpected number of path segments");
    }
    Ok(segments[0].as_str())
}

fn require_no_query(query: Option<&str>) -> Result<(), &'static str> {
    if query.is_some() {
        Err("deep link action does not accept query parameters")
    } else {
        Ok(())
    }
}

fn parse_query(
    raw_query: Option<&str>,
    allowed_keys: &[&str],
) -> Result<BTreeMap<String, String>, &'static str> {
    let Some(raw_query) = raw_query else {
        return Ok(BTreeMap::new());
    };
    if raw_query.is_empty() {
        return Err("deep link query is empty");
    }

    let mut params = BTreeMap::new();
    for pair in raw_query.split('&') {
        let (key, raw_value) = pair
            .split_once('=')
            .ok_or("deep link query pair is malformed")?;
        if key.is_empty()
            || raw_value.contains('=')
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
        {
            return Err("deep link query pair is malformed");
        }
        if !allowed_keys.contains(&key) {
            return Err("deep link query parameter is not allowlisted");
        }
        let value = decode_component_once(raw_value)?;
        if params.insert(key.to_string(), value).is_some() {
            return Err("deep link query parameter is duplicated");
        }
    }
    Ok(params)
}

fn decode_component_once(raw: &str) -> Result<String, &'static str> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("deep link contains invalid percent encoding");
            }
            let high =
                hex_value(bytes[index + 1]).ok_or("deep link contains invalid percent encoding")?;
            let low =
                hex_value(bytes[index + 2]).ok_or("deep link contains invalid percent encoding")?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "deep link component is not valid UTF-8")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_resource_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_RESOURCE_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Helpdesk routes interpolate a conversation UUID into a protected API path.
/// Keep this stricter than the generic resource-id grammar so a ticket id,
/// uppercase UUID alias, or encoded structure cannot acquire conversation
/// semantics at the native shell boundary.
fn is_canonical_lowercase_uuid(value: &str) -> bool {
    if value.len() != 36 {
        return false;
    }

    value.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
    })
}

fn is_subscriber_target(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_SUBSCRIBER_BYTES {
        return false;
    }
    if !value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'@' | b'-')
    }) {
        return false;
    }
    let at_count = value.bytes().filter(|byte| *byte == b'@').count();
    if at_count == 0 {
        return is_resource_id(value);
    }
    at_count == 1 && !value.starts_with('@') && !value.ends_with('@') && !value.contains("..")
}

fn required_opaque<'a>(
    params: &'a BTreeMap<String, String>,
    key: &str,
    max_bytes: usize,
) -> Result<&'a str, &'static str> {
    let value = params
        .get(key)
        .ok_or("deep link is missing a required parameter")?;
    if !is_opaque_value(value, max_bytes) {
        return Err("deep link parameter value is not allowed");
    }
    Ok(value)
}

fn required_base64url<'a>(
    params: &'a BTreeMap<String, String>,
    key: &str,
    min_bytes: usize,
    max_bytes: usize,
) -> Result<&'a str, &'static str> {
    let value = params
        .get(key)
        .ok_or("deep link is missing a required parameter")?;
    if value.len() < min_bytes
        || value.len() > max_bytes
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("deep link parameter value is not allowed");
    }
    Ok(value)
}

fn optional_opaque<'a>(
    params: &'a BTreeMap<String, String>,
    key: &str,
    max_bytes: usize,
) -> Result<Option<&'a str>, &'static str> {
    match params.get(key) {
        Some(value) if is_opaque_value(value, max_bytes) => Ok(Some(value)),
        Some(_) => Err("deep link parameter value is not allowed"),
        None => Ok(None),
    }
}

fn is_opaque_value(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
}

fn append_query_pair(target: &mut String, separator: &mut char, key: &str, value: &str) {
    target.push(*separator);
    target.push_str(key);
    target.push('=');
    target.push_str(value);
    *separator = '&';
}

fn auth_link_rejection(raw: &str, validation_error: &'static str) -> Option<DeepLinkDelivery> {
    if !(raw == "moosewave://auth"
        || raw.starts_with("moosewave://auth/")
        || raw.starts_with("moosewave://auth?"))
    {
        return None;
    }
    let flow = if raw.starts_with("moosewave://auth/magic") {
        Some("magic".to_string())
    } else if raw.starts_with("moosewave://auth/reset") {
        Some("reset".to_string())
    } else {
        None
    };
    let reason = match validation_error {
        "auth link version is unsupported" => AuthLinkRejectionReason::UnsupportedVersion,
        "auth link audience is not native" => AuthLinkRejectionReason::WrongDevice,
        "auth link flow does not match its path" => AuthLinkRejectionReason::WrongFlow,
        "auth link signature is malformed" => AuthLinkRejectionReason::InvalidSignature,
        _ => AuthLinkRejectionReason::InvalidLink,
    };
    Some(DeepLinkDelivery::Rejected { reason, flow })
}

fn deliver<R: Runtime>(app: &AppHandle<R>, message: DeepLinkDelivery) {
    let emit_now = match app.state::<DeepLinkState>().delivery.lock() {
        Ok(mut delivery) => delivery.submit(message),
        Err(_) => {
            tracing::error!("deep-link delivery queue lock was poisoned");
            return;
        }
    };
    if let Some(message) = emit_now {
        if let Err(error) = app.emit(DEEP_LINK_EVENT, vec![message]) {
            tracing::error!(%error, "failed to emit validated deep-link message");
        }
    }
}

/// Route a raw OS/second-instance URL through the native validator. The return
/// value indicates whether the URL was accepted and is used to avoid focusing
/// an existing window for rejected second-instance intents.
pub fn dispatch_deep_link<R: Runtime>(app: &AppHandle<R>, raw: &str) -> bool {
    let payload = match validate_postwave_url(raw) {
        Ok(payload) => payload,
        Err(reason) => {
            // Never include rejected attacker-controlled input in logs.
            tracing::warn!(reason, "rejected postwave deep link");
            if let Some(rejection) = auth_link_rejection(raw, reason) {
                deliver(app, rejection);
            }
            return false;
        }
    };
    // Log only the action. Subscriber links can contain an email address and
    // auth/migration links contain secrets, so even a redacted URL-shaped log
    // is unnecessary PII exposure.
    tracing::info!(action = payload.action, "accepted deep link");

    deliver(
        app,
        DeepLinkDelivery::Opened {
            url: payload.raw_url,
        },
    );
    true
}

/// The renderer attaches its event listener before calling this command.
/// Marking it ready and draining under the same mutex closes the usual
/// startup race between `get_current` and JS listener initialization.
#[tauri::command]
pub fn deep_link_take_pending(
    window: WebviewWindow,
    state: State<'_, DeepLinkState>,
) -> Result<Vec<DeepLinkDelivery>, String> {
    crate::ipc_guard::ensure_main_bundled_window(&window, "deep-link delivery")?;
    state
        .delivery
        .lock()
        .map(|mut delivery| delivery.mark_ready_and_drain())
        .map_err(|_| "deep-link delivery queue is unavailable".to_string())
}

/// Register future URL delivery and recover cold-start URLs retained by the
/// plugin before `setup` ran.
pub fn register<R: Runtime>(app: &AppHandle<R>) -> Result<(), tauri_plugin_deep_link::Error> {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            dispatch_deep_link(&handle, url.as_str());
        }
    });

    if let Some(urls) = app.deep_link().get_current()? {
        for url in urls {
            dispatch_deep_link(app, url.as_str());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct AuthContractFixtures {
        version: u8,
        audience: String,
        cases: Vec<AuthContractFixture>,
    }

    #[derive(Deserialize)]
    struct AuthContractFixture {
        source: String,
        flow: String,
        token: String,
        state: String,
        signature: String,
        native_url: String,
    }

    fn auth_contract_fixtures() -> AuthContractFixtures {
        serde_json::from_str(include_str!("../../auth-link-v1-contract-fixtures.json"))
            .expect("shared auth-link v1 fixtures must parse")
    }

    #[test]
    fn accepts_and_canonicalizes_every_supported_shape() {
        let cases = [
            (
                "moosewave://approval/abc%2D123",
                "moosewave://approval/abc-123",
                "/app/approvals/abc-123",
            ),
            (
                "moosewave://subscriber/foo%2Bbar%40example.com",
                "moosewave://subscriber/foo+bar@example.com",
                "/app/subscribers?email=foo+bar@example.com",
            ),
            (
                "moosewave://campaign/CAMP_42",
                "moosewave://campaign/CAMP_42",
                "/app/campaigns/CAMP_42",
            ),
            (
                "moosewave://sequence/seq_42",
                "moosewave://sequence/seq_42",
                "/app/sequences/seq_42",
            ),
            (
                "moosewave://settings",
                "moosewave://settings",
                "/app/settings",
            ),
            (
                "moosewave://migrations/api-key?state=st_1&source=hubspot",
                "moosewave://migrations/api-key?source=hubspot&state=st_1",
                "/app/migrations/api-key?source=hubspot&state=st_1",
            ),
            (
                "moosewave://migrate/brevo/api-key-entry?state=st_2",
                "moosewave://migrations/api-key?source=brevo&state=st_2",
                "/app/migrations/api-key?source=brevo&state=st_2",
            ),
        ];

        for (raw, canonical, route) in cases {
            let payload = validate_postwave_url(raw)
                .unwrap_or_else(|error| panic!("expected {raw:?} to be valid: {error}"));
            assert_eq!(payload.raw_url, canonical);
            assert_eq!(payload.route, route);
        }

        let fixtures = auth_contract_fixtures();
        assert_eq!(fixtures.version.to_string(), AUTH_LINK_VERSION);
        assert_eq!(fixtures.audience, AUTH_LINK_NATIVE_AUDIENCE);
        assert_eq!(fixtures.cases.len(), 3);
        for fixture in fixtures.cases {
            let payload = validate_postwave_url(&fixture.native_url).unwrap_or_else(|error| {
                panic!(
                    "expected backend-compatible {} fixture to pass native validation: {error}",
                    fixture.source
                )
            });
            assert_eq!(payload.resource_id, fixture.flow);
            assert_eq!(payload.route, format!("/auth/{}", fixture.flow));
            assert_eq!(payload.raw_url, fixture.native_url);
            assert!(payload
                .raw_url
                .contains(&format!("token={}", fixture.token)));
            assert!(payload
                .raw_url
                .contains(&format!("state={}", fixture.state)));
            assert!(payload
                .raw_url
                .contains(&format!("sig={}", fixture.signature)));
        }

        let magic_alias = auth_contract_fixtures().cases.remove(0);
        let alias_url = magic_alias.native_url.replacen(
            "moosewave://auth/magic?",
            "moosewave://auth/magic-link?",
            1,
        );
        assert_eq!(
            validate_postwave_url(&alias_url).unwrap().raw_url,
            magic_alias.native_url
        );
        let reset_alias = auth_contract_fixtures().cases.remove(2);
        let alias_url = reset_alias.native_url.replacen(
            "moosewave://auth/reset?",
            "moosewave://auth/reset-password?",
            1,
        );
        assert_eq!(
            validate_postwave_url(&alias_url).unwrap().raw_url,
            reset_alias.native_url
        );
    }

    #[test]
    fn routes_every_registry_entity_desktop_supports() {
        // One case per ENTITY_COLLECTIONS row. These mirror
        // packages/route-map/src/entities.ts: every entity whose
        // `surfaces.desktop` is not "none" must produce a real /app route here,
        // or the link the TS registry mints does nothing when the user taps it.
        let cases = [
            ("approval", "approvals"),
            ("campaign", "campaigns"),
            ("sequence", "sequences"),
            ("form", "forms"),
            ("list", "lists"),
            ("segment", "segments"),
            ("helpdesk-conversation", "helpdesk"),
            ("template", "templates"),
            ("migration", "migrations"),
            ("discount", "discounts"),
            ("integration", "integrations"),
            ("affiliate", "affiliates"),
        ];
        for (action, collection) in cases {
            let id = if action == "helpdesk-conversation" {
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            } else {
                "rid_1"
            };
            let raw = format!("moosewave://{action}/{id}");
            let payload = validate_postwave_url(&raw)
                .unwrap_or_else(|err| panic!("{action} must route: {err}"));
            assert_eq!(payload.action, action);
            assert_eq!(payload.resource_id, id);
            assert_eq!(payload.route, format!("/app/{collection}/{id}"));
            assert_eq!(payload.raw_url, raw);
        }
    }

    #[test]
    fn helpdesk_deep_links_are_conversation_only_and_canonical_uuid_only() {
        let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let payload = validate_postwave_url(&format!("moosewave://helpdesk-conversation/{id}"))
            .expect("canonical conversation UUID must route");
        assert_eq!(payload.action, "helpdesk-conversation");
        assert_eq!(payload.resource_id, id);
        assert_eq!(payload.route, format!("/app/helpdesk/{id}"));

        for raw in [
            format!("moosewave://helpdesk-ticket/{id}"),
            "moosewave://helpdesk-conversation/ticket_123".to_string(),
            "moosewave://helpdesk-conversation/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA".to_string(),
            "moosewave://helpdesk-conversation/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa".to_string(),
            "moosewave://helpdesk-conversation/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa%00".to_string(),
            format!(
                "moosewave://helpdesk-conversation/{}",
                "a".repeat(MAX_RESOURCE_ID_BYTES + 1)
            ),
        ] {
            assert!(
                validate_postwave_url(&raw).is_err(),
                "accepted non-canonical helpdesk route {raw:?}"
            );
        }
    }

    #[test]
    fn rejects_entities_desktop_has_no_section_for() {
        // The registry marks these `surfaces.desktop: "none"` because
        // desktop-router.ts SECTION_SLUGS has no matching section — desktop's
        // automation section is `automations` and its `webhooks` section is the
        // OUTBOUND catalog. Routing them would land on unknown-destination, so
        // the shell refuses the link instead of opening a dead window.
        for action in [
            "flow",
            "inbound-webhook",
            "landing-page",
            "sequence-template",
        ] {
            let raw = format!("moosewave://{action}/rid_1");
            assert!(
                validate_postwave_url(&raw).is_err(),
                "{action} must be rejected — desktop has no section for it",
            );
        }
    }

    #[test]
    fn rejects_unknown_actions_paths_and_parameters() {
        for raw in [
            "https://approval/abc",
            "POSTWAVE://approval/abc",
            "moosewave://nuke/everything",
            "moosewave://approval",
            "moosewave://approval/abc/extra",
            "moosewave://approval/abc/",
            "moosewave://approval/abc?from=email",
            "moosewave://subscriber/..",
            "moosewave://subscriber/not+an+email",
            "moosewave://settings/extra",
            "moosewave://settings?next=campaigns",
            "moosewave://auth/settings?token=abc",
            "moosewave://auth/magic?token=abc&next=settings",
            "moosewave://auth/oauth-return?state=nonce_1",
            "moosewave://migrations/api-key?source=unknown",
            "moosewave://migrations/secret?source=hubspot",
            "moosewave://migrate/brevo/private-app-token?state=abc",
            "moosewave://migrate/brevo/api-key-entry?source=hubspot",
        ] {
            assert!(
                validate_postwave_url(raw).is_err(),
                "expected {raw:?} to be rejected"
            );
        }
    }

    #[test]
    fn rejects_duplicates_missing_values_and_length_overflows() {
        for raw in [
            "moosewave://auth/magic",
            "moosewave://auth/magic?token=",
            "moosewave://auth/magic?token=abc&token=def",
            "moosewave://auth/magic?token=abc&state=one&state=two",
            "moosewave://migrations/api-key?source=hubspot&source=brevo",
            "moosewave://migrations/api-key?state=",
            "moosewave://migrations/api-key?",
        ] {
            assert!(validate_postwave_url(raw).is_err(), "accepted {raw:?}");
        }

        let fixture = auth_contract_fixtures().cases.remove(0);
        let long_token = fixture
            .native_url
            .replace(&fixture.token, &"a".repeat(MAX_AUTH_TOKEN_BYTES + 1));
        assert!(validate_postwave_url(&long_token).is_err());
        let long_state = format!(
            "moosewave://migrations/api-key?state={}",
            "a".repeat(MAX_STATE_BYTES + 1)
        );
        assert!(validate_postwave_url(&long_state).is_err());
        let huge = format!("moosewave://approval/{}", "a".repeat(MAX_DEEP_LINK_BYTES));
        assert!(validate_postwave_url(&huge).is_err());
    }

    #[test]
    fn enforces_every_signed_v1_auth_field_and_canonicalizes_backend_order() {
        let fixture = auth_contract_fixtures().cases.remove(0);
        let backend_order = format!(
            "moosewave://auth/magic?aud=mobile&flow=magic&sig={}&state={}&token={}&v=1",
            fixture.signature, fixture.state, fixture.token
        );
        assert_eq!(
            validate_postwave_url(&backend_order).unwrap().raw_url,
            fixture.native_url
        );

        let mutations = [
            fixture.native_url.replace("&v=1", ""),
            fixture.native_url.replace("v=1", "v=2"),
            fixture.native_url.replace("flow=magic", "flow=reset"),
            fixture.native_url.replace("aud=mobile", "aud=web"),
            fixture
                .native_url
                .replace("&state=desktop_magic_123456", ""),
            fixture.native_url.replace(&fixture.signature, "short"),
            format!("{}&extra=value", fixture.native_url),
            format!("{}&sig={}", fixture.native_url, fixture.signature),
        ];
        for mutation in mutations {
            assert!(
                validate_postwave_url(&mutation).is_err(),
                "accepted incomplete or contradictory auth envelope"
            );
        }
    }

    #[test]
    fn percent_decodes_exactly_once_and_rejects_encoded_structure() {
        for raw in [
            "moosewave://approval/%252e%252e",
            "moosewave://approval/%2e%2e",
            "moosewave://approval/abc%2fsettings",
            "moosewave://approval/%",
            "moosewave://approval/%GG",
            "moosewave://auth/magic?token=abc%2526state%253Devil",
            "moosewave://auth/magic?token=abc%26state%3Devil",
            "moosewave://migrations/api-key?state=abc%250a",
            "moosewave://migrations/api-key?state=abc%0a",
        ] {
            assert!(validate_postwave_url(raw).is_err(), "accepted {raw:?}");
        }
    }

    #[test]
    fn rejects_authority_confusion_fragments_and_controls() {
        for raw in [
            "moosewave://user@approval/abc",
            "moosewave://approval:443/abc",
            "moosewave://approval/%5csettings",
            "moosewave://approval/abc#settings",
            "moosewave://approval/abc\nsettings",
            "moosewave://approv%61l/abc",
            "moosewave:///approval/abc",
        ] {
            assert!(validate_postwave_url(raw).is_err(), "accepted {raw:?}");
        }
    }

    #[test]
    fn pending_delivery_is_bounded_deduplicated_and_drained_once() {
        let mut queue = DeliveryQueue::default();
        let settings = DeepLinkDelivery::Opened {
            url: "moosewave://settings".into(),
        };
        assert_eq!(queue.submit(settings.clone()), None);
        assert_eq!(queue.submit(settings.clone()), None);
        assert_eq!(queue.pending.len(), 1);

        for index in 0..(MAX_PENDING_LINKS + 3) {
            queue.submit(DeepLinkDelivery::Opened {
                url: format!("moosewave://campaign/campaign_{index}"),
            });
        }
        assert_eq!(queue.pending.len(), MAX_PENDING_LINKS);
        assert_ne!(queue.pending.front(), Some(&settings));

        let drained = queue.mark_ready_and_drain();
        assert_eq!(drained.len(), MAX_PENDING_LINKS);
        assert!(queue.mark_ready_and_drain().is_empty());
        assert_eq!(queue.submit(settings.clone()), Some(settings));
    }

    #[test]
    fn queues_redacted_auth_rejections_without_echoing_secret_input() {
        let rejection = auth_link_rejection(
            "moosewave://auth/magic?token=do-not-echo&v=2",
            "auth link version is unsupported",
        )
        .expect("auth-shaped input should have a recovery message");
        assert_eq!(
            rejection,
            DeepLinkDelivery::Rejected {
                reason: AuthLinkRejectionReason::UnsupportedVersion,
                flow: Some("magic".to_string()),
            }
        );
        let serialized = serde_json::to_string(&rejection).unwrap();
        assert!(!serialized.contains("do-not-echo"));
        assert_eq!(
            serialized,
            r#"{"kind":"rejected","reason":"unsupported_version","flow":"magic"}"#
        );
    }
}
